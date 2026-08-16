/**
 * HTTP client for the ActiveCommunities (ActiveNet) cookieless REST API.
 * Endpoint reference: docs/activenet-api.md. This module owns transport
 * conventions (headers, paging-in-a-header, the lying HTTP-200 envelope);
 * it knows nothing about tools or MCP.
 */

import { PER_PAGE } from "./constants.js";

function base(org) {
  return `https://anc.apm.activecommunities.com/${encodeURIComponent(org)}/rest`;
}

function headers(org, page) {
  const h = {
    "X-Requested-With": "XMLHttpRequest",
    Referer: `https://anc.apm.activecommunities.com/${org}/activity/search`,
    "User-Agent": "seattle-activities-mcp/2 (+https://github.com/coryking/seattle-parks)",
  };
  // Paging rides in a request HEADER, not the body — an upstream quirk.
  if (page) h.page_info = JSON.stringify({ order_by: "", page_number: page, total_records_per_page: PER_PAGE });
  return h;
}

/** Envelope check: HTTP status lies (200 on errors); response_code is truth. */
function unwrap(json, what) {
  const code = json?.headers?.response_code;
  if (code === "0000") return json;
  if (code === "0001") return null; // "No result found" — a valid empty answer
  const msg = json?.headers?.response_message || "unknown upstream error";
  throw new Error(`upstream ${what}: ${msg} (code ${code ?? "none"})`);
}

export async function upstreamGet(org, path, { ttl = 3600 } = {}) {
  const res = await fetch(`${base(org)}/${path}`, {
    headers: headers(org),
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`upstream GET ${path}: HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    throw new Error(`org "${org}" does not look like a live ActiveCommunities tenant (non-JSON reply)`);
  }
  return unwrap(await res.json(), path);
}

export async function upstreamPost(org, path, body, page) {
  const res = await fetch(`${base(org)}/${path}`, {
    method: "POST",
    headers: { ...headers(org, page), "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upstream POST ${path}: HTTP ${res.status}`);
  return unwrap(await res.json(), path);
}

/** The org's facet vocabulary (sites, seasons, categories, …). Cached GET. */
export async function getVocabulary(org) {
  const json = await upstreamGet(org, "activities/filters?locale=en-US");
  const b = json?.body ?? {};
  return {
    sites: b.sites ?? [],
    centers: b.centers ?? [],
    seasons: b.seasons ?? [],
    categories: b.categories ?? [],
    otherCategories: b.othercategories ?? [],
  };
}

/** Human-facing activity page (the SPA route, not the REST API). */
export function publicDetailUrl(org, id) {
  return `https://anc.apm.activecommunities.com/${org}/activity/search/detail/${id}`;
}
