/** Shared limits and prose. Keep this dependency-free — everything imports it. */

export const DEFAULT_ORG = "seattle";

/** Upstream page size for activities/list; fewer round-trips than the site's 20. */
export const PER_PAGE = 50;

/** Page fan-out cap for one search (PER_PAGE * MAX_PAGES sections). */
export const MAX_PAGES = 12;

/** Above this many matching sections we refuse and ask for a narrower query. */
export const TOO_BROAD = 600;

/**
 * get_activity_detail id cap: each id costs 4 upstream requests and free-tier
 * Workers allow 50 subrequests per request (4 * 12 = 48).
 */
export const MAX_DETAIL_IDS = 12;

export const TZ_NOTE =
  "All dates/times are local to the organization (Seattle: America/Los_Angeles).";
