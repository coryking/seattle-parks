/**
 * get_activity_detail — the drill tier. Per id, four upstream calls in
 * parallel (detail + schedule/registration dates + price + button status)
 * joined into one dossier. The buttonstatus verdict is upstream's own answer
 * to "can I register right now", including the reason when it's no — we never
 * derive that ourselves.
 */

import { z } from "zod";
import { MAX_DETAIL_IDS, TZ_NOTE } from "../constants.js";
import { upstreamGet, publicDetailUrl } from "../upstream.js";
import { orgParam, orgOrError } from "../orgs.js";
import {
  stripHtml, truncate, decodeEntities, agesLabel,
  shapeScheduleAndWindow, shapeButtonStatus, shapePrice,
} from "../lib.js";

async function fetchDossier(org, id) {
  const [det, mrd, price, btn] = await Promise.all([
    upstreamGet(org, `activity/detail/${id}?locale=en-US`, { ttl: 300 }),
    upstreamGet(org, `activity/detail/meetingandregistrationdates/${id}?locale=en-US`, { ttl: 300 }),
    upstreamGet(org, `activity/detail/estimateprice/${id}?locale=en-US&ui_random=1`, { ttl: 300 }),
    upstreamGet(org, `activity/detail/buttonstatus/${id}?locale=en-US`, { ttl: 60 }),
  ]);
  const d = det?.body?.detail ?? {};
  const sw = shapeScheduleAndWindow(mrd?.body?.meeting_and_registration_dates ?? {});
  const reg = shapeButtonStatus(btn?.body ?? {});
  return {
    id,
    name: stripHtml(d.activity_name || ""),
    number: d.activity_number || null,
    category: [d.category, d.sub_category].filter(Boolean).map(decodeEntities).join(" / ") || null,
    season: d.season_name || null,
    ages: decodeEntities(d.age_description || "") || agesLabel(d.age_min_year, d.age_max_year),
    location:
      (d.centers || []).map((c) => decodeEntities(c.name ?? c.desc ?? "")).filter(Boolean).join(", ") ||
      decodeEntities(d.location_description || "") ||
      null,
    description: truncate(stripHtml(d.catalog_description || ""), 800),
    notes: stripHtml(d.online_notes || "") || null,
    sessions: d.other_info?.sessions ?? null,
    dates: { first: d.first_date || null, last: d.last_date || null },
    schedule: sw.schedule,
    registration: {
      ...reg,
      window: sw.window,
      method_hint: reg.enrollable_now ? "online" : reg.reason ? "not currently online — see reason" : "unknown",
    },
    price: shapePrice(price?.body?.estimateprice),
    gender: d.allowed_gender && !/coed|any/i.test(d.allowed_gender) ? d.allowed_gender : null,
    private_lesson: d.private_lesson || false,
    availability: stripHtml(d.space_message || "") || null,
    urls: { detail: publicDetailUrl(org, id) },
  };
}

async function handler({ ids, org: orgArg }) {
  const orgRes = orgOrError(orgArg);
  if (orgRes.error) return orgRes.error;
  const org = orgRes.slug;
  const dossiers = await Promise.all(
    ids.map((id) => fetchDossier(org, id).catch((err) => ({ id, error: String(err?.message ?? err) })))
  );
  return { org, count: dossiers.length, tz: TZ_NOTE, activities: dossiers };
}

export default {
  name: "get_activity_detail",
  config: {
    title: "Get full activity details (registration, schedule, price)",
    description:
      `Fetch the drill-tier dossier for specific activity sections by id (from search_activities): full description, structured meeting schedule with exception dates, the registration window (opens/closes timestamps), an authoritative enrollable-right-now verdict with the upstream reason when sign-up is not possible (e.g. online registration closed, phone-only), price (a single fee when one clearly applies, otherwise the raw fee tiers — match tiers to the user's membership/residency yourself), and enroll/detail links. Call this for the user's shortlist BEFORE presenting options — it is the only tier that knows whether the sign-up button actually works. Max ${MAX_DETAIL_IDS} ids per call (each id costs 4 upstream requests); batch the shortlist, never a whole result set.`,
    inputSchema: {
      ids: z.array(z.number().int()).min(1).max(MAX_DETAIL_IDS).describe(`Section ids from search_activities results. 1–${MAX_DETAIL_IDS}.`),
      org: orgParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handler,
};
