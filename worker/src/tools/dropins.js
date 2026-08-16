/**
 * search_dropins — the drop-in calendars, a separate upstream product from
 * registered programs. One events call per calendar covers every center.
 *
 * Upstream silently ignores its own search_start_time/search_end_time and
 * always returns a fixed rolling ~5-week window — so date filtering happens
 * worker-side and the response states the window it actually covered.
 * (House rule: never pass through a filter upstream ignores.)
 */

import { z } from "zod";
import { TZ_NOTE } from "../constants.js";
import { upstreamGet, upstreamPost } from "../upstream.js";
import { orgParam, orgOrError } from "../orgs.js";
import { decodeEntities, resolveFacet, flattenDropins, filterDropins } from "../lib.js";

async function eventsForCalendar(org, cal) {
  const filt = await upstreamPost(org, "onlinecalendar/filters?locale=en-US", { calendar_id: cal.id });
  const centerIds = (filt?.body?.center ?? []).map((c) => c.id);
  const ev = await upstreamPost(org, "onlinecalendar/multicenter/events?locale=en-US", {
    calendar_id: cal.id, center_ids: centerIds, display_all: 0,
    search_start_time: "", search_end_time: "", facility_ids: [],
    activity_category_ids: [], activity_sub_category_ids: [], activity_ids: [],
    activity_min_age: null, activity_max_age: null, event_type_ids: [],
  });
  return flattenDropins(ev?.body ?? {}, cal.name);
}

async function handler(a) {
  const orgRes = orgOrError(a.org);
  if (orgRes.error) return orgRes.error;
  const org = orgRes.slug;

  const calsJson = await upstreamGet(org, "onlinecalendar/calendars?locale=en-US");
  const allCals = (calsJson?.body?.calendars ?? []).map((c) => ({
    id: c.calendar_id ?? c.id,
    name: decodeEntities(c.name ?? c.desc ?? ""),
  }));
  if (!allCals.length) return { org, sessions_count: 0, sessions: [], note: "This org exposes no drop-in calendars." };

  let cals = allCals;
  const notes = [];
  if (a.calendars?.length) {
    const r = resolveFacet(a.calendars, allCals.map((c) => ({ id: c.id, desc: c.name })));
    if (r.unmatched.length) {
      notes.push(`Unmatched calendars: ${r.unmatched.join(", ")}. Available: ${allCals.map((c) => c.name).join(", ")}.`);
    }
    for (const amb of r.ambiguous) {
      notes.push(`Ambiguous calendar "${amb.input}": ${amb.candidates.map((c) => c.name).join(", ")}.`);
    }
    cals = allCals.filter((c) => r.ids.includes(String(c.id)));
    if (!cals.length) return { org, sessions_count: 0, sessions: [], notes, available_calendars: allCals.map((c) => c.name) };
  }

  const perCal = await Promise.all(cals.map((cal) => eventsForCalendar(org, cal)));
  const all = perCal.flat();
  const window = all.length ? { from: all[0].date, to: all[all.length - 1].date } : null;

  // Default to the next 7 days when no dates given — the upstream window holds
  // ~5 weeks of every center's sessions, far too much for an unscoped skim.
  let { date_from, date_to } = a;
  if (!date_from && !date_to) {
    const today = new Date();
    const plus7 = new Date(today.getTime() + 7 * 86400_000);
    date_from = today.toISOString().slice(0, 10);
    date_to = plus7.toISOString().slice(0, 10);
    notes.push(`No dates given — defaulted to the next 7 days (${date_from}..${date_to}). Pass date_from/date_to for more of the ~5-week window.`);
  }
  const sessions = filterDropins(all, { ...a, date_from, date_to });

  return {
    org,
    sessions_count: sessions.length,
    sessions_in_window: all.length,
    window_covered: window,
    window_note: "Upstream returns a fixed rolling window (~5 weeks ahead); dates outside it are not queryable, by anyone. Date filtering is applied worker-side.",
    query: {
      calendars: cals.map((c) => c.name),
      centers: a.centers || [],
      date_from,
      date_to,
      keyword: a.keyword || null,
    },
    notes,
    tz: TZ_NOTE,
    sessions,
  };
}

export default {
  name: "search_dropins",
  config: {
    title: "Search drop-in sessions (dated calendar)",
    description:
      `List dated drop-in sessions (open swim, open gym, tot time, senior programs…) across an org's community centers — concrete occurrences with date, start/end time, center, and facility. This is a separate catalog from registered programs: no enrollment, just show up. Upstream only publishes a rolling ~5-week window; the response states the window covered, and dates outside it are not queryable at all. Filters (dates, keyword, centers) are applied worker-side and echoed back.`,
    inputSchema: {
      calendars: z.array(z.string()).optional().describe(`Calendar names to include, resolved fuzzily — Seattle has: Adult, Multiple-Ages, Senior, Swimming, Tot, Tween/Teen, Youth. Omit for all.`),
      centers: z.array(z.string()).optional().describe(`Community-center name fragments to keep, e.g. ["Green Lake"]. Substring match, worker-side.`),
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`Keep sessions on/after this date (YYYY-MM-DD).`),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`Keep sessions on/before this date (YYYY-MM-DD).`),
      keyword: z.string().optional().describe(`Substring match on session title, e.g. "lap swim", "pickleball".`),
      org: orgParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handler,
};
