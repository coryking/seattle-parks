/**
 * Seattle Parks activity finder — remote MCP server.
 *
 * Seattle Parks & Rec runs on ActiveCommunities, whose activity-search endpoint
 * is POST-only and returns a large, noisy payload. This Worker exposes that
 * catalog as a Model Context Protocol server (Streamable HTTP) so any MCP client
 * — claude.ai Connectors, Claude Code, etc. — can search activities and look up
 * prices as tool calls, reached server-side (no code-execution egress allowlist).
 *
 * This is an MCP server ONLY — there is no REST/GET API. The single endpoint is
 * POST /mcp. Two tools: search_activities, get_activity_prices.
 *
 * Upstream (POST):
 *   https://anc.apm.activecommunities.com/seattle/rest/activities/list?locale=en-US
 * No auth, no cookies, no CSRF token are needed upstream — it's a public catalog.
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { version as VERSION } from "../package.json";

const UPSTREAM =
  "https://anc.apm.activecommunities.com/seattle/rest/activities/list?locale=en-US";
const PER_PAGE = 50; // upstream page size; fewer round-trips than the site's 20
const MAX_PAGES = 40; // safety stop

// Default to the central-Seattle cluster near First Hill (98101).
// Override with the `sites` arg. Discover IDs from any Seattle Parks search URL.
const DEFAULT_SITES = [
  "434", // Washington Park Arboretum
  "16", // Medgar Evers Pool
  "399", // Yesler Community Center
  "255", // Miller Playfield
  "29", // Miller Community Center
  "307", // Madison Pool
  "147", // Garfield Teen Life Center
  "110", // Cal Anderson Park
  "8", // Garfield Community Center
  "23", // International District/Chinatown C.C.
  "278", // Montlake Community Center
];
const DEFAULT_SEASON = "51"; // Summer 2026 (52=Fall 2026, 53=School Year 2026-27)

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const SERVER_INSTRUCTIONS = `Search Seattle Parks & Rec (ActiveCommunities) program registrations: camps, classes, lessons, and drop-ins.

Workflow:
- Call search_activities to discover/compare programs. It returns everything EXCEPT price (left out to stay fast).
- Call get_activity_prices ONLY when the user asks what specific activities cost — pass just the id(s) they care about, never bulk-price a whole result set.

Field semantics in search results:
- open_spots: number of open registration spots; -1 = uncapped drop-in, 0 = full.
- age band is [age_min_year, age_max_year) — age_max_year is EXCLUSIVE.
- each activity carries detail_url (info page) and enroll_url (sign-up).

Covers Seattle Parks & Rec only — not other cities, school districts, or private programs.`;

function createServer() {
  const server = new McpServer(
    { name: "seattle-activities", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "search_activities",
    {
      title: "Search Seattle Parks activities",
      description:
        "Search live Seattle Parks & Rec activity registrations (camps, classes, lessons, drop-ins) from the ActiveCommunities catalog, filtered by neighborhood, season, age, keyword, and category. Use when someone wants to discover or compare Seattle Parks programs. Returns matching activities WITHOUT prices — call get_activity_prices for those. Seattle Parks only.",
      inputSchema: {
        keyword: z
          .string()
          .optional()
          .describe("Free-text search over activity titles/descriptions, e.g. 'lego', 'soccer', 'pottery'."),
        covers: z
          .array(z.number().int())
          .optional()
          .describe(
            "Ages (in years) the activity must actually serve; keeps an activity if its age band covers ANY listed age, e.g. [8,9] for an 8- or 9-year-old. This is the precise age filter — prefer it over min_age/max_age."
          ),
        season: z
          .string()
          .optional()
          .describe("Season ID: 51=Summer 2026, 52=Fall 2026, 53=School Year 2026-27. Defaults to 51 (Summer 2026)."),
        sites: z
          .array(z.string())
          .optional()
          .describe(
            "ActiveCommunities site (location) IDs to search. Defaults to a central-Seattle cluster (Capitol Hill / Central District / First Hill / International District). Only set when the user names specific rec centers and you know their IDs."
          ),
        categories: z
          .array(z.string())
          .optional()
          .describe(
            "Category IDs: 22=Camps, 23=Performing Arts, 26=Visual/Crafts, 27=Athletics, 34=Martial Arts, 35=Nature, 38=Enrichment."
          ),
        min_age: z
          .number()
          .int()
          .optional()
          .describe("Upstream minimum-age gate (years). Coarser than covers; prefer covers for precise matching."),
        max_age: z
          .number()
          .int()
          .optional()
          .describe("Upstream maximum-age gate (years). Coarser than covers; prefer covers for precise matching."),
        days: z
          .string()
          .optional()
          .describe("7-char day-of-week bitmask, Sunday-first (SMTWTFS), '1'=include. Default '0000000' = any day."),
        exclude_full: z
          .boolean()
          .optional()
          .describe("Drop activities with 0 open spots. Default true."),
        no_swim: z
          .boolean()
          .optional()
          .describe("Drop pool/swim/dive activities. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const result = await searchActivities(makeOpts(args));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "get_activity_prices",
    {
      title: "Get Seattle Parks registration prices",
      description:
        "Fetch the live resident registration price for one or more activities by id. Use ONLY when the user asks what specific activities cost — prices are intentionally excluded from search_activities to keep it fast. Pass just the id(s) the user is interested in; do not bulk-price an entire search. Returns the resident fee as a string (e.g. \"$250.00\"); free=true means no charge.",
      inputSchema: {
        ids: z
          .array(z.number().int())
          .min(1)
          .max(100)
          .describe("Activity ids (the `id` field from search_activities results). 1–100 per call."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ ids }) => {
      const result = await getPrices(ids);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  return server;
}

// A fresh server per request (MCP SDK >=1.26 requirement — avoids cross-client
// response leaks in a stateless handler).
function mcp(request, env, ctx) {
  return createMcpHandler(createServer())(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcp(request, env, ctx);
    }
    // 100% MCP — no REST API. Point humans (and health checks) at the endpoint.
    const info = {
      service: "seattle-activities",
      protocol: "Model Context Protocol (Streamable HTTP)",
      endpoint: "/mcp",
      tools: ["search_activities", "get_activity_prices"],
      repo: "https://github.com/coryking/seattle-parks",
    };
    return new Response(JSON.stringify(info, null, 2), {
      status: url.pathname === "/" ? 200 : 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  },
};

// ---------------------------------------------------------------------------
// Core logic (shared by both tools; same proxy behavior as the old GET shim)
// ---------------------------------------------------------------------------

function makeOpts(a = {}) {
  const sites = a.sites && a.sites.length ? a.sites.map(String) : DEFAULT_SITES;
  const season = a.season || DEFAULT_SEASON;
  const minAge = a.min_age ?? null;
  const maxAge = a.max_age ?? null;
  const keyword = a.keyword || "";
  const categories = a.categories ? a.categories.map(String) : [];
  const days = a.days || "0000000";
  const covers = (a.covers || []).map(Number).filter((n) => !Number.isNaN(n));
  const excludeFull = a.exclude_full !== false; // default true
  const noSwim = a.no_swim !== false; // default true

  return {
    upstream: { sites, season, minAge, maxAge, keyword, categories, days },
    covers,
    excludeFull,
    noSwim,
    echo: {
      sites,
      season,
      min_age: minAge,
      max_age: maxAge,
      keyword,
      categories,
      covers,
      exclude_full: excludeFull,
      no_swim: noSwim,
    },
  };
}

async function searchActivities(opts) {
  const items = await fetchAll(opts);
  const activities = items
    .map(shape)
    .filter((a) => keep(a, opts))
    .sort(
      (a, b) =>
        a.location.localeCompare(b.location) || a.name.localeCompare(b.name)
    );
  return {
    source: "Seattle Parks & Rec (ActiveCommunities), live",
    generated_at: new Date().toISOString(),
    query: opts.echo,
    count: activities.length,
    activities,
  };
}

async function getPrices(ids) {
  const prices = await Promise.all(ids.map(fetchPrice));
  return { count: prices.length, prices };
}

function buildBody(u) {
  return {
    activity_search_pattern: {
      skills: [],
      time_after_str: "",
      days_of_week: u.days,
      activity_select_param: 2,
      center_ids: [],
      time_before_str: "",
      open_spots: null,
      activity_id: null,
      activity_category_ids: u.categories,
      date_before: "",
      min_age: u.minAge,
      date_after: "",
      activity_type_ids: [],
      site_ids: u.sites,
      for_map: false,
      geographic_area_ids: [],
      season_ids: [u.season],
      activity_department_ids: [],
      activity_other_category_ids: [],
      child_season_ids: [],
      activity_keyword: u.keyword,
      instructor_ids: [],
      max_age: u.maxAge,
      custom_price_from: "",
      custom_price_to: "",
    },
    activity_transfer_pattern: {},
  };
}

async function fetchPage(body, page) {
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://anc.apm.activecommunities.com",
      Referer: "https://anc.apm.activecommunities.com/seattle/activity/search",
      "User-Agent":
        "coryk-ing-activities-shim/1.0 (+https://github.com/coryking/coryk-ing-website)",
      page_info: JSON.stringify({
        order_by: "",
        page_number: page,
        total_records_per_page: PER_PAGE,
      }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  return res.json();
}

async function fetchAll(opts) {
  const body = buildBody(opts.upstream);
  const first = await fetchPage(body, 1);
  if (first.headers && first.headers.response_code !== "0000") {
    throw new Error(`upstream: ${first.headers.response_message || "error"}`);
  }
  const items = [...(first.body.activity_items || [])];
  const totalPages = Math.min(
    (first.headers && first.headers.page_info && first.headers.page_info.total_page) || 1,
    MAX_PAGES
  );
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(body, i + 2))
    );
    for (const r of rest) items.push(...(r.body.activity_items || []));
  }
  return items;
}

// Live registration price for one activity (resident price only).
// Upstream returns either a flat `estimate_price` string, or a `prices[]` array
// with Resident / Non-resident tiers — we surface just the resident figure.
async function fetchPrice(id) {
  const url =
    "https://anc.apm.activecommunities.com/seattle/rest/activity/detail/estimateprice/" +
    encodeURIComponent(id) +
    "?locale=en-US&options=%5Bobject%20Object%5D&ui_random=1";
  try {
    const res = await fetch(url, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "*/*",
        Origin: "https://anc.apm.activecommunities.com",
        "User-Agent":
          "coryk-ing-activities-shim/1.0 (+https://github.com/coryking/coryk-ing-website)",
        page_info: JSON.stringify({ page_number: 1, total_records_per_page: 20 }),
      },
    });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    const ep = (await res.json()).body.estimateprice || {};
    return { id: Number(id), free: !!ep.free, price: residentPrice(ep) };
  } catch (err) {
    return { id: Number(id), error: String(err && err.message ? err.message : err) };
  }
}

function residentPrice(ep) {
  if (ep.free) return "$0.00";
  // Flat fee: a single estimate_price string and no tiers.
  if (ep.estimate_price) return ep.estimate_price;
  // Tiered: pick the "Resident" detail (fall back to the first listed price).
  const details = (ep.prices || []).flatMap((p) => p.details || []);
  const resident = details.find((d) => /resident/i.test(d.description) && !/non/i.test(d.description));
  return (resident || details[0] || {}).price || "";
}

function shape(i) {
  const loc = (i.location && i.location.label) || "";
  return {
    id: i.id,
    number: i.number,
    name: decode(i.name),
    description: decode(i.desc || ""),
    ages: agesLabel(i),
    age_min_year: i.age_min_year,
    age_max_year: i.age_max_year, // exclusive: "less than 9" -> 9
    days: i.days_of_week,
    time: i.time_range,
    dates: i.date_range,
    date_start: i.date_range_start,
    date_end: i.date_range_end,
    open_spots: i.total_open, // -1 = uncapped drop-in, 0 = full
    location: loc,
    detail_url: i.detail_url,
    enroll_url: i.enroll_now && i.enroll_now.href,
  };
}

function agesLabel(i) {
  const mn = i.age_min_year || 0;
  const mx = i.age_max_year || 0;
  if (!mn && !mx) return "all ages";
  return mx ? `${mn}-${mx - 1}` : `${mn}+`;
}

function keep(a, opts) {
  if (opts.excludeFull && a.open_spots === 0) return false;
  if (opts.noSwim && isSwim(a)) return false;
  if (opts.covers.length && !coversAny(a, opts.covers)) return false;
  return true;
}

function isSwim(a) {
  if (/pool/i.test(a.location)) return true;
  return /\b(swim|dive|diving|aqua|aquatics|water)\b/i.test(a.name);
}

// Activity band is [min, max); max_year 0 means no upper bound.
function coversAny(a, ages) {
  const mn = a.age_min_year || 0;
  const mx = a.age_max_year || 0;
  return ages.some((age) => age >= mn && (mx === 0 || age < mx));
}

function decode(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
