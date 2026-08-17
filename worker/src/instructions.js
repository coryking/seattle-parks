/** Server-level instructions: the cross-tool workflow. Tool specifics live with each tool. */

import { MAX_DETAIL_IDS, TZ_NOTE } from "./constants.js";

export const SERVER_INSTRUCTIONS = `Search ActiveCommunities (ActiveNet) recreation catalogs — program registrations (camps, classes, lessons) and drop-in sessions. Defaults to Seattle Parks & Rec; other cities via the org parameter (list_orgs).

The intended path is a funnel — spend context in proportion to the step:
1. search_activities — cheap grouped summaries (programs with compact section rows). Use it to narrow.
2. get_activity_detail — for the shortlist ONLY (max ${MAX_DETAIL_IDS} ids). Returns the registration window, an authoritative can-you-enroll-right-now verdict with the reason when not, schedule with exceptions, and price. ALWAYS call it on the sections you are about to present to the user — open_spots alone does NOT mean sign-up is possible (registration may not have opened, may have closed online, or may be phone-only).
3. search_dropins — dated drop-in sessions (open gym/swim etc.); a different catalog than registered programs.

get_filters exposes each org's vocabulary (sites, seasons, categories). You rarely need it first: search_activities accepts human names ("Evans Pool", "fall") and resolves them, echoing the resolution in the response header. Read the "note:" lines (or "notes" field) of every response — unresolved or ambiguous inputs are reported there, never silently dropped. Skim tiers return compact markdown; detail and vocabulary tools return JSON.

Ages: an activity's band is [age_min, age_max_excl) — the max is exclusive. Pass the person's actual age(s) in "ages" for precise matching. ${TZ_NOTE}`;
