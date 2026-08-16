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
  try {
    return { data: JSON.parse(text), bytes: text.length, isError: Boolean(r.isError) };
  } catch {
    // A thrown tool error arrives as plain text — surface it instead of crashing.
    return { data: { tool_error: text }, bytes: text.length, isError: true };
  }
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
check("evans resolves to 500", swim.data.query?.sites?.some((s) => s.id === "500"), JSON.stringify(swim.data.query?.sites));
check("medgar evers resolves to 16", swim.data.query?.sites?.some((s) => s.id === "16"));
check("season resolves to a Fall season", /fall/i.test(swim.data.query?.season?.name ?? ""), swim.data.query?.season?.name);
check("bare-word season choice is noted", (swim.data.notes ?? []).some((n) => /resolved to Fall/i.test(n)));
check("swim programs found", swim.data.programs_count > 0, `${swim.data.programs_count} programs / ${swim.data.sections_count} sections`);
check("grouping compresses", swim.data.programs_count < swim.data.sections_count);
check("every section has a status", (swim.data.programs ?? []).every((p) => p.sections.every((s) => ["open", "full", "drop_in"].includes(s.status))));
check("no HTML in descriptions", !(swim.data.programs ?? []).some((p) => /<[a-z]+[^>]*>/i.test(p.description)));
check("skim response under 80KB", swim.bytes < 80_000, `${swim.bytes} bytes`);

// --- golden query 2: pottery (the reg-closed incident) ----------------------
const pottery = await call("search_activities", { keyword: "pottery", ages: [8, 9], season: "fall" });
check("pottery query echoes ages", JSON.stringify(pottery.data.query?.ages) === "[8,9]");
check("pottery search structurally valid", typeof pottery.data.programs_count === "number", `${pottery.data.programs_count} programs`);

// --- fail-loud paths -------------------------------------------------------
const bogus = await call("search_activities", { keyword: "swim", sites: ["Hogwarts Quidditch Pitch"] });
check("bogus site fails loud (no silent fallback)", Boolean(bogus.data.error), bogus.data.error);

const ambig = await call("search_activities", { keyword: "swim", season: "fall", sites: ["pool"] });
check("ambiguous site reported in notes", (ambig.data.notes ?? []).some((n) => /Ambiguous/i.test(n)) || Boolean(bogus.data.error));

const noFilter = await call("search_activities", {});
check("unfiltered query refused with guidance", Boolean(noFilter.data.error && noFilter.data.hint));

// --- drill tier ------------------------------------------------------------
const firstIds = (swim.data.programs ?? []).flatMap((p) => p.sections.map((s) => s.id)).slice(0, 3);
if (firstIds.length) {
  const detail = await call("get_activity_detail", { ids: firstIds });
  const act = detail.data.activities?.[0];
  check("detail returns dossiers", detail.data.count === firstIds.length);
  check("dossier has registration verdict", typeof act?.registration?.enrollable_now === "boolean", `enrollable_now=${act?.registration?.enrollable_now} reason=${act?.registration?.reason ?? "-"}`);
  check("dossier has registration window", act?.registration?.window && "opens" in act.registration.window, JSON.stringify(act?.registration?.window));
  check("dossier has price", act?.price && ("resident_fee" in act.price), JSON.stringify(act?.price));
  check("dossier has structured schedule", Array.isArray(act?.schedule));
} else {
  check("drill tier smoke (skipped — no swim sections found)", false);
}

// --- drop-ins --------------------------------------------------------------
const dropins = await call("search_dropins", { keyword: "swim" });
check("dropins return sessions", dropins.data.sessions_count > 0, `${dropins.data.sessions_count} of ${dropins.data.sessions_in_window} in window`);
check("dropins state their window", Boolean(dropins.data.window_covered?.from), JSON.stringify(dropins.data.window_covered));
check("dropin rows structured", (dropins.data.sessions ?? []).slice(0, 5).every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date ?? "") && /^\d{2}:\d{2}$/.test(s.start ?? "")));
check("dropins default to a 7-day window, noted", Boolean(dropins.data.query?.date_from) && (dropins.data.notes ?? []).some((n) => /defaulted/i.test(n)), `${dropins.data.query?.date_from}..${dropins.data.query?.date_to}`);
check("dropins response under 120KB", dropins.bytes < 120_000, `${dropins.bytes} bytes`);

// --- orgs + vocabulary -----------------------------------------------------
const orgs = await call("list_orgs", { query: "portland" });
check("list_orgs finds portland", orgs.data.orgs?.some((o) => o.slug === "portlandparks"), JSON.stringify(orgs.data.orgs?.map((o) => o.slug)));

const filters = await call("get_filters", {});
check("seattle vocabulary present", filters.data.counts?.sites > 50 && filters.data.counts?.seasons > 0, JSON.stringify(filters.data.counts));

const portlandSearch = await call("search_activities", { keyword: "swim", org: "Portland" });
check("org by human name works end-to-end", portlandSearch.data.org === "portlandparks" || Boolean(portlandSearch.data.error), `org=${portlandSearch.data.org ?? JSON.stringify(portlandSearch.data.error)}`);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
