/**
 * search_activities — the skim tier. Upstream search fanned across pages,
 * reshaped into program groups with compact section rows. Deliberately
 * excludes registration window / enrollability / price (drill tier's job).
 */

import { z } from "zod";
import { DEFAULT_ORG, MAX_PAGES, TOO_BROAD, MAX_DETAIL_IDS, TZ_NOTE } from "../constants.js";
import { upstreamPost, getVocabulary, publicDetailUrl } from "../upstream.js";
import { orgParam, orgOrError } from "../orgs.js";
import { decodeEntities, shapeSection, filterSections, groupPrograms, resolveFacet, resolveSeason } from "../lib.js";

/**
 * Resolve one user-supplied facet list; collects human-readable problems into
 * `notes` and returns upstream ids. Ambiguity and misses are surfaced, never
 * guessed around.
 */
function resolveOrExplain(inputs, facet, label, notes) {
  const r = resolveFacet(inputs, facet);
  if (r.unmatched.length) {
    notes.push(`Unmatched ${label}: ${r.unmatched.join(", ")} — not in this org's vocabulary (see get_filters); they were NOT searched.`);
  }
  for (const a of r.ambiguous) {
    notes.push(`Ambiguous ${label} "${a.input}" — candidates: ${a.candidates.map((c) => `${c.name} (${c.id})`).join("; ")}. Re-run with one of these.`);
  }
  return r;
}

function echoQuery(org, a, sites, seasons) {
  return {
    org,
    keyword: a.keyword || null,
    ages: a.ages || [],
    season: seasons.resolved[0] || null,
    sites: sites.resolved,
    weekdays: a.weekdays || [],
    date_after: a.date_after || null,
    date_before: a.date_before || null,
    start_after: a.start_after || null,
    end_before: a.end_before || null,
  };
}

function buildSearchBody(a, sites, cats, seasons) {
  return {
    activity_search_pattern: {
      skills: [], time_after_str: "", days_of_week: "0000000", activity_select_param: 2,
      center_ids: [], time_before_str: "", open_spots: null, activity_id: null,
      activity_category_ids: cats.ids, date_before: a.date_before || "", min_age: null,
      date_after: a.date_after || "", activity_type_ids: [], site_ids: sites.ids,
      for_map: false, geographic_area_ids: [], season_ids: seasons.ids,
      activity_department_ids: [], activity_other_category_ids: [], child_season_ids: [],
      activity_keyword: a.keyword || "", instructor_ids: [], max_age: null,
      custom_price_from: "", custom_price_to: "",
    },
    activity_transfer_pattern: {},
  };
}

async function handler(a) {
  const orgRes = orgOrError(a.org);
  if (orgRes.error) return orgRes.error;
  const org = orgRes.slug;

  const meaningful = a.keyword || a.ages?.length || a.sites?.length || a.categories?.length || a.season;
  if (!meaningful) {
    return {
      error: "Query too broad: provide at least one of keyword, ages, sites, categories, or season.",
      hint: "Call get_filters to see this org's sites, seasons, and categories, then search with a filter.",
    };
  }

  const vocab = await getVocabulary(org);
  const notes = [];
  const sites = resolveOrExplain(a.sites, vocab.sites, "sites", notes);
  const cats = resolveOrExplain(a.categories, [...vocab.categories, ...vocab.otherCategories], "categories", notes);
  const seasons = resolveSeason(a.season, vocab.seasons, new Date().toISOString());
  notes.push(...seasons.notes);
  if (a.sites?.length && !sites.ids.length) {
    return {
      error: "None of the requested sites resolved; nothing was searched.",
      notes,
      sites_vocabulary_sample: vocab.sites.slice(0, 20).map((s) => ({ id: s.id, name: decodeEntities(s.desc) })),
      hint: "Use get_filters for the full site list.",
    };
  }

  const body = buildSearchBody(a, sites, cats, seasons);
  const first = await upstreamPost(org, "activities/list?locale=en-US", body, 1);
  if (!first) {
    return {
      org, query: echoQuery(org, a, sites, seasons),
      programs_count: 0, sections_count: 0, notes, programs: [],
      hint: "No matches. Consider widening: drop a filter, or check the season (get_filters lists what's open for registration).",
    };
  }

  const total = first.headers?.page_info?.total_records ?? first.body.activity_items?.length ?? 0;
  if (total > TOO_BROAD) {
    return {
      error: `Query matches ${total} sections — too broad to return. Narrow it and retry.`,
      query: echoQuery(org, a, sites, seasons), notes,
      categories_available: vocab.categories.map((c) => ({ id: c.id, name: decodeEntities(c.desc) })),
      hint: "Add a keyword, category, sites, or ages filter.",
    };
  }

  const totalPages = Math.min(first.headers?.page_info?.total_page || 1, MAX_PAGES);
  const items = [...(first.body.activity_items || [])];
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => upstreamPost(org, "activities/list?locale=en-US", body, i + 2))
    );
    for (const r of rest) if (r) items.push(...(r.body.activity_items || []));
  }

  // Worker-side filters for what upstream can't do reliably (see lib.js).
  const sections = filterSections(items.map(shapeSection), {
    ages: a.ages, weekdays: a.weekdays, start_after: a.start_after, end_before: a.end_before,
  });
  const programs = groupPrograms(sections);

  return {
    org,
    query: echoQuery(org, a, sites, seasons),
    programs_count: programs.length,
    sections_count: sections.length,
    sections_upstream: total,
    notes,
    detail_url_template: publicDetailUrl(org, "{id}"),
    next_step: `Before presenting choices to the user, call get_activity_detail with the section ids they care about (max ${MAX_DETAIL_IDS}) — it returns the registration window, whether sign-up is possible right now, and price.`,
    tz: TZ_NOTE,
    programs,
  };
}

export default {
  name: "search_activities",
  config: {
    title: "Search recreation programs (grouped summaries)",
    description:
      `Search an ActiveCommunities org's registered-program catalog (camps, classes, lessons) and return compact program summaries — sections grouped by program name and location, descriptions truncated, one row per section with days/time/dates/spots/status (open|full|drop_in). This is the cheap discovery tier: results deliberately EXCLUDE the registration window, enrollability, and price — before presenting specific options to the user, pass their section ids to get_activity_detail (open spots alone does not mean sign-up is currently possible). Accepts human names for sites and season ("Evans Pool", "fall") and resolves them, reporting anything unmatched or ambiguous in "notes". Requires at least one filter. Does not cover drop-in sessions (use search_dropins). Default org: ${DEFAULT_ORG}.`,
    inputSchema: {
      keyword: z.string().optional().describe(`Free-text match on program names/descriptions, e.g. "swim", "pottery", "camp".`),
      ages: z.array(z.number().int().min(0).max(120)).optional().describe(`Actual ages (years) of the participant(s); keeps programs whose age band covers ANY listed age. E.g. [8] for an 8-year-old.`),
      season: z.string().optional().describe(`Season by name or id — "fall", "Fall 2026", or "52". Omit to search all seasons.`),
      sites: z.array(z.string()).optional().describe(`Locations by name or id — e.g. ["Evans Pool", "Medgar Evers"]. Resolved against the org's site vocabulary; misses are reported in notes.`),
      categories: z.array(z.string()).optional().describe(`Category by name or id — e.g. ["Aquatics"], ["Camps"]. get_filters lists them.`),
      weekdays: z.array(z.enum(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])).optional().describe(`Keep sections meeting on ANY of these days.`),
      start_after: z.string().regex(/^\d{2}:\d{2}$/).optional().describe(`Keep sections starting at or after this 24h local time, e.g. "16:00".`),
      end_before: z.string().regex(/^\d{2}:\d{2}$/).optional().describe(`Keep sections ending at or before this 24h local time, e.g. "19:00".`),
      date_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`Only sections starting on/after this date (YYYY-MM-DD).`),
      date_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`Only sections starting on/before this date (YYYY-MM-DD).`),
      org: orgParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handler,
};
