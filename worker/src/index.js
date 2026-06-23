/**
 * Seattle Parks activity-search GET shim.
 *
 * Seattle Parks & Rec runs on ActiveCommunities, whose activity-search endpoint
 * is POST-only. A claude.ai chat (and anything else that can only issue GETs)
 * can't talk to it. This Worker accepts a GET, translates the query string into
 * the upstream POST body, paginates, filters server-side, and returns clean JSON
 * with permissive CORS.
 *
 * Upstream (POST):
 *   https://anc.apm.activecommunities.com/seattle/rest/activities/list?locale=en-US
 *
 * No auth, no cookies, no CSRF token are needed upstream — it's a public catalog.
 */

const UPSTREAM =
  "https://anc.apm.activecommunities.com/seattle/rest/activities/list?locale=en-US";
const PER_PAGE = 50; // upstream page size; fewer round-trips than the site's 20
const MAX_PAGES = 40; // safety stop

// Default to the central-Seattle cluster near First Hill (98101).
// Override with ?sites=8,29,...  Discover IDs from filters.sites in any response.
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    const pretty = url.searchParams.has("pretty");
    if (url.searchParams.has("help") || url.pathname === "/help") {
      return json(usage(), 200, true);
    }

    // Second endpoint: live registration prices for one or many activity IDs.
    //   /price?id=84263        or   /price?ids=84263,85421,83719
    if (url.pathname === "/price" || url.pathname === "/prices") {
      const ids = [
        ...(url.searchParams.get("id") ? [url.searchParams.get("id")] : []),
        ...(url.searchParams.get("ids") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ];
      if (!ids.length) {
        return json({ error: "pass ?id=<activityId> or ?ids=84263,85421,..." }, 400, true);
      }
      if (ids.length > 100) {
        return json({ error: "max 100 ids per request" }, 400, true);
      }
      try {
        const prices = await Promise.all(ids.map(fetchPrice));
        return json({ count: prices.length, prices }, 200, pretty);
      } catch (err) {
        return json({ error: String(err && err.message ? err.message : err) }, 502);
      }
    }

    try {
      const opts = parseQuery(url.searchParams);
      const items = await fetchAll(opts);
      const activities = items
        .map(shape)
        .filter((a) => keep(a, opts))
        .sort(
          (a, b) =>
            a.location.localeCompare(b.location) || a.name.localeCompare(b.name)
        );
      return json(
        {
          source: "Seattle Parks & Rec (ActiveCommunities), live",
          generated_at: new Date().toISOString(),
          query: opts.echo,
          count: activities.length,
          activities,
        },
        200,
        pretty
      );
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 502);
    }
  },
};

function parseQuery(p) {
  const list = (v) =>
    (v || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const num = (v) => (v === null || v === "" ? null : Number(v));

  const sites = list(p.get("sites"));
  const season = p.get("season") || DEFAULT_SEASON;
  const minAge = num(p.get("min_age"));
  const maxAge = num(p.get("max_age"));
  const keyword = p.get("keyword") || "";
  const categories = list(p.get("categories"));
  const days = p.get("days") || "0000000";

  // Precise post-filters (defaults match what we actually want for a kid search)
  const covers = list(p.get("covers")).map(Number).filter((n) => !Number.isNaN(n));
  const excludeFull = p.get("exclude_full") !== "false";
  const noSwim = p.get("no_swim") !== "false";

  return {
    upstream: {
      sites: sites.length ? sites : DEFAULT_SITES,
      season,
      minAge,
      maxAge,
      keyword,
      categories,
      days,
    },
    covers,
    excludeFull,
    noSwim,
    echo: {
      sites: sites.length ? sites : DEFAULT_SITES,
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

function json(obj, status, pretty = false) {
  return new Response(JSON.stringify(obj, null, pretty ? 2 : 0), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function usage() {
  return {
    what: "GET shim over Seattle Parks ActiveCommunities activity search.",
    example:
      "/?season=51&sites=8,29,399,23,278&covers=8,9&exclude_full=true&no_swim=true",
    params: {
      sites: "comma-separated site IDs (default: central-Seattle cluster near First Hill)",
      season: "season ID. 51=Summer 2026, 52=Fall 2026, 53=School Year 2026-27 (default 51)",
      min_age: "upstream age gate (optional)",
      max_age: "upstream age gate (optional)",
      keyword: "free-text search (optional)",
      categories:
        "comma-separated category IDs: 22=Camps, 23=Performing Arts, 26=Visual/Crafts, 27=Athletics, 34=Martial Arts, 35=Nature, 38=Enrichment",
      covers:
        "comma-separated ages the activity must actually serve, e.g. 8,9 (keeps a band if it covers ANY). Precise client-side filter.",
      exclude_full: "drop activities with 0 open spots (default true)",
      no_swim: "drop pool/swim/dive activities (default true)",
      pretty: "indent the JSON for humans (default off — compact saves ~half the tokens)",
    },
    price_endpoint: {
      what: "Live resident registration price for one or many activities (a second fetch).",
      usage: "/price?ids=84263,85421,83719  (or ?id=84263). Max 100 ids.",
      returns:
        "{ count, prices: [{ id, free, price }] }. price is the resident fee as a string (e.g. \"$250.00\"); free=true means no charge.",
    },
    notes:
      "open_spots: -1 = uncapped drop-in, 0 = full. age_max_year is exclusive. Each activity carries detail_url + enroll_url. Prices live at /price (not in the list, to keep it fast).",
  };
}
