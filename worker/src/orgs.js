/**
 * Org (tenant) resolution shared by every tool: turns a slug or human name
 * into a validated slug, or into a candidates/hint error object — never a
 * guess. Also owns the shared `org` parameter schema so its description
 * exists in exactly one place.
 */

import { z } from "zod";
import { DEFAULT_ORG } from "./constants.js";
import { resolveOrg } from "./lib.js";
import { TENANTS } from "./tenants.js";

export const orgParam = z
  .string()
  .optional()
  .describe(
    `Organization — a slug ("seattle", "portlandparks", "denver") or a city/agency name ("Portland", "Chicago Park District"), resolved against the known-tenant registry. Default "seattle". Ambiguous or unknown names return candidates; list_orgs browses the registry.`
  );

/**
 * Resolve the org argument or produce the error payload directly —
 * callers `if (org.error) return org.error`.
 */
export function orgOrError(input) {
  if (!input) return { slug: DEFAULT_ORG };
  const r = resolveOrg(input, TENANTS);
  if (r.slug) return r;
  if (r.ambiguous) {
    return {
      error: {
        error: `Org "${input}" is ambiguous.`,
        candidates: r.ambiguous,
        hint: "Re-run with one of these slugs.",
      },
    };
  }
  return {
    error: {
      error: `Org "${input}" matches nothing in the registry and is not slug-shaped.`,
      hint: "Call list_orgs to browse known orgs, or pass an exact slug (lowercase letters/digits).",
    },
  };
}
