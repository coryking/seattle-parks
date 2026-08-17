#!/usr/bin/env node
/**
 * Live MCP smoke test. Run `npm run dev` in worker/ (wrangler dev), then:
 *   node scripts/smoke.mjs [http://localhost:8787/mcp]
 *
 * Replays the golden queries against the real upstream through the worker and
 * asserts structural invariants (resolution, statuses, size budgets) — not
 * exact rows, since upstream data shifts daily.
 */

const URL_ = process.argv[2] || "http://localhost:8787/mcp";
let nextId = 1;
let session = null;
let failures = 0;

async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  session = res.headers.get("mcp-session-id") || session;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // Streamable HTTP may answer as SSE; take the last data: line.
  const payload = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()
    : text;
  const json = JSON.parse(payload);
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function call(tool, args) {
  const r = await rpc("tools/call", { name: tool, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  // Skim tiers return markdown (data stays null); JSON tools parse into data.
  let data = null;
  try { data = JSON.parse(text); } catch { /* markdown or thrown-error text */ }
  return { text, data, bytes: text.length, isError: Boolean(r.isError) };
}

function check(label, cond, detail = "") {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  (${detail})` : ""}`);
}

// --- handshake -------------------------------------------------------------
// Fresh session per attempt: right after a deploy, edge POPs serve a mix of
// old and new worker versions for a short while — wait until we land on one
// with the current five-tool surface before asserting anything.
async function handshake() {
  session = null;
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const tools = await rpc("tools/list", {});
  return { init, tools };
}

let init, tools;
for (let attempt = 1; ; attempt++) {
  ({ init, tools } = await handshake());
  if (tools?.tools?.length === 5) break;
  if (attempt >= 12) break;
  console.log(`… waiting for deploy propagation (attempt ${attempt}: ${tools?.tools?.length ?? 0} tools, version ${init?.serverInfo?.version})`);
  await new Promise((r) => setTimeout(r, 10_000));
}
check("initialize", init?.serverInfo?.name === "seattle-activities", init?.serverInfo?.version);
check("five tools", tools?.tools?.length === 5, tools?.tools?.map((t) => t.name).join(","));

// --- golden query 1: the original failing prompt ---------------------------
// "does my little mcp have swim lessons in it? pull them for evans and megar evans pools"
const swim = await call("search_activities", {
  keyword: "swim", season: "fall", sites: ["Evans Pool", "medgar evers"],
});
const header = swim.text.match(/^# (\w+): (\d+) programs \/ (\d+) sections/);
check("markdown header present", Boolean(header), swim.text.split("\n")[0]);
check("evans resolves to 500", swim.text.includes("Evans Pool (500)"));
check("medgar evers resolves to 16", swim.text.includes("Medgar Evers Pool (16)"));
check("season resolves to a Fall season", /season=Fall \d{4}/.test(swim.text));
check("bare-word season choice is noted", /note: .*resolved to Fall/.test(swim.text));
check("swim programs found", header && Number(header[2]) > 0, `${header?.[2]} programs / ${header?.[3]} sections`);
check("grouping compresses", header && Number(header[2]) < Number(header[3]));
const rows = swim.text.split("\n").filter((l) => /^\d+ \| /.test(l));
check("every section row carries spots/status", rows.length > 0 && rows.every((l) => /\| (\d+ open|full|drop-in)$/.test(l)), `${rows.length} rows`);
check("no HTML in output", !/<[a-z]+[^>]*>/i.test(swim.text));
check("skim response under 45KB", swim.bytes < 45_000, `${swim.bytes} bytes`);
check("no unserialized objects in skim", !swim.text.includes("[object Object]"));

// --- golden query 2: pottery (the reg-closed incident) ----------------------
const pottery = await call("search_activities", { keyword: "pottery", ages: [8, 9], season: "fall" });
check("pottery query echoes ages", pottery.text.includes("ages=8,9") || Boolean(pottery.data), pottery.text.split("\n")[0]);
check("pottery search structurally valid", /^# \w+: \d+ programs/.test(pottery.text) || typeof pottery.data?.programs_count === "number");

// --- fail-loud paths -------------------------------------------------------
const bogus = await call("search_activities", { keyword: "swim", sites: ["Hogwarts Quidditch Pitch"] });
check("bogus site fails loud (no silent fallback)", Boolean(bogus.data.error), bogus.data.error);

const ambig = await call("search_activities", { keyword: "swim", season: "fall", sites: ["pool"] });
check("ambiguous site reported with candidates", (ambig.data?.notes ?? []).some((n) => /Ambiguous/i.test(n)) || /Ambiguous/.test(ambig.text));

const noFilter = await call("search_activities", {});
check("unfiltered query refused with guidance", Boolean(noFilter.data.error && noFilter.data.hint));

// --- drill tier ------------------------------------------------------------
const firstIds = rows.slice(0, 3).map((l) => Number(l.split(" | ")[0]));
if (firstIds.length) {
  const detail = await call("get_activity_detail", { ids: firstIds });
  const act = detail.data.activities?.[0];
  check("detail returns dossiers", detail.data.count === firstIds.length);
  check("dossier has registration verdict", typeof act?.registration?.enrollable_now === "boolean", `enrollable_now=${act?.registration?.enrollable_now} reason=${act?.registration?.reason ?? "-"}`);
  check("dossier has registration window", act?.registration?.window && "opens" in act.registration.window, JSON.stringify(act?.registration?.window));
  check("dossier price is total: fee, free, tiers, or an explicit note", act?.price && "fee" in act.price && (act.price.fee !== null || act.price.free === true || Array.isArray(act.price.tiers) || Boolean(act.price.fee_note)), JSON.stringify(act?.price));
  check("no mislabeled fee: tiers ride along whenever they exist", detail.data.activities.every((a2) => !a2.price?.fee_label || Array.isArray(a2.price?.tiers)));
  check("dossier has structured schedule", Array.isArray(act?.schedule));
  check("no unserialized objects anywhere in dossiers", !JSON.stringify(detail.data).includes("[object Object]"));
} else {
  check("drill tier smoke (skipped — no swim sections found)", false);
}

// --- drop-ins --------------------------------------------------------------
const dropins = await call("search_dropins", { keyword: "swim" });
const dHeader = dropins.text.match(/^# (\w+) drop-ins: (\d+) sessions, (\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}) \(upstream window/);
check("dropins return sessions", dHeader && Number(dHeader[2]) > 0, dropins.text.split("\n")[0]);
check("dropins state their window", Boolean(dHeader), dHeader?.[0]);
check("dropin rows structured under date headings", /^## \d{4}-\d{2}-\d{2} \([A-Z][a-z]{2}\)$/m.test(dropins.text) && /^\d{2}:\d{2}-\d{2}:\d{2} \| /m.test(dropins.text));
check("dropins default to a 7-day window, noted", /note: No dates given — defaulted/.test(dropins.text), `${dHeader?.[3]}..${dHeader?.[4]}`);
check("dropins response under 80KB", dropins.bytes < 80_000, `${dropins.bytes} bytes`);

// --- orgs + vocabulary -----------------------------------------------------
const orgs = await call("list_orgs", { query: "portland" });
check("list_orgs finds portland", orgs.data.orgs?.some((o) => o.slug === "portlandparks"), JSON.stringify(orgs.data.orgs?.map((o) => o.slug)));

const filters = await call("get_filters", {});
check("seattle vocabulary present", filters.data.counts?.sites > 50 && filters.data.counts?.seasons > 0, JSON.stringify(filters.data.counts));

const portlandSearch = await call("search_activities", { keyword: "swim", org: "Portland" });
check("org by human name works end-to-end", portlandSearch.text.startsWith("# portlandparks:") || Boolean(portlandSearch.data?.error), portlandSearch.text.split("\n")[0]);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
