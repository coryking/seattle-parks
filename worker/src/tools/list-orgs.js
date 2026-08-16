/**
 * list_orgs — the curated tenant registry (see tenants.js for provenance).
 * Static data; no upstream calls.
 */

import { z } from "zod";
import { TENANTS, TENANTS_VALIDATED } from "../tenants.js";

async function handler({ query }) {
  let orgs = TENANTS;
  if (query) {
    const q = query.toLowerCase();
    orgs = orgs.filter((t) => t.slug.includes(q) || t.name.toLowerCase().includes(q));
  }
  return {
    validated: TENANTS_VALIDATED,
    count: orgs.length,
    note: "Curated, not exhaustive. US host only; Canadian tenants live on a different host and are not reachable via these tools.",
    orgs,
  };
}

export default {
  name: "list_orgs",
  config: {
    title: "List known ActiveCommunities organizations",
    description:
      `List known ActiveCommunities org slugs (cities/districts on the same platform) usable as the org parameter of the other tools. The registry is curated by out-of-band enumeration (validated ${TENANTS_VALIDATED}) — there is no upstream discovery endpoint — so it is honest but not exhaustive: an org absent here may still work if you know its slug. Zero sites+centers+seasons means the org is registered but effectively dormant.`,
    inputSchema: {
      query: z.string().optional().describe(`Optional case-insensitive filter on slug or name, e.g. "portland".`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler,
};
