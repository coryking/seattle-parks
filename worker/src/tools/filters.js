/**
 * get_filters — an org's facet vocabulary. A browse/repair tool, not a
 * required first hop: search_activities resolves human names itself.
 */

import { getVocabulary } from "../upstream.js";
import { orgParam, orgOrError } from "../orgs.js";
import { decodeEntities } from "../lib.js";

async function handler({ org: orgArg }) {
  const orgRes = orgOrError(orgArg);
  if (orgRes.error) return orgRes.error;
  const org = orgRes.slug;
  const v = await getVocabulary(org);
  const clean = (list) => list.map((f) => ({ id: f.id, name: decodeEntities(f.desc) }));
  return {
    org,
    counts: { sites: v.sites.length, centers: v.centers.length, seasons: v.seasons.length, categories: v.categories.length },
    seasons: clean(v.seasons),
    categories: clean(v.categories),
    sites: clean(v.sites),
    centers: clean(v.centers),
  };
}

export default {
  name: "get_filters",
  config: {
    title: "Get an org's search vocabulary",
    description:
      `Return an org's facet vocabulary: sites (locations), seasons (with ids), and activity categories. Use when the user asks what exists ("which pools are there?", "what categories?"), when a name failed to resolve in search_activities, or to discover valid season names. search_activities resolves human names itself, so this is NOT a required first step.`,
    inputSchema: { org: orgParam },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handler,
};
