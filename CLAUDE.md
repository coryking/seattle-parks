# seattle-parks

A remote MCP server (Cloudflare Worker, Streamable HTTP at `/mcp`) over the
ActiveCommunities/ActiveNet recreation-registration REST API, defaulting to Seattle Parks &
Rec. The audience for this CLAUDE.md is a session working on the server itself.

## Engineering ownership

You own this codebase. No one else will refactor it, fix technical debt, or improve the
architecture — if you don't do it when you notice it, it doesn't get done. Act as the
engineer, not just the implementer: push back on approaches that create debt, and when a
bridge or adapter seems necessary, ask why — if the answer is "something upstream of it is
wrong," fix that instead.

## Public repo — no personal data

Never commit personal data: no home geography (neighborhoods, "near my house" comments,
personal default site clusters), no family details, no conversation content — in code,
comments, issues, or docs. Defaults in code must be city-neutral. Personalization is the
MCP *client's* job (claude.ai memory), never this repo's.

## The prompting regime — there is no backwards compatibility

The consumer of this API is an LLM that re-reads the tool schemas and server instructions
at the start of every session and adapts on the spot. Nothing binds at build time, so
nothing breaks at change time:

- **Semantics are free.** Rename fields, restructure responses, delete tools. No
  versioning, no deprecation cycles, no migration shims — rip out the old thing entirely.
  All design effort goes into the schema-of-today; none into the bridge-from-yesterday.
- **Identity and cached prompting are the only compat surfaces.** The connector URL, the
  server name, and tool names (they live in users' permission allowlists) are *addresses* —
  nothing re-reads them, so keep them stable. And any prompting that lives outside the
  server (installed skills, client memories, READMEs quoting API shapes) is a fossil the
  moment the server changes — so don't create any. Everything the calling LLM needs lives
  in the tool schemas and server instructions, which deploy atomically with the code.

## One authoritative source

- **Upstream truth:** `docs/activenet-api.md` — the reverse-engineered ActiveNet API
  reference, including the regeneration recipe. Endpoint behavior questions get answered
  there (or probed live and recorded there), not re-discovered.
- **Interface truth:** the tool schemas and server `instructions` in `worker/src/index.js`.
- Everything else (README, plugin manifest) points at those; it never restates them.

## Response-shape rules (AX)

The API is designed for an agent with a finite context budget, not a renderer:

- **Summary at the top.** Counts, query echo, resolution results, and warnings come first
  in every response; rows after. Truncation eats the bottom.
- **Structured over strings.** ISO dates, 24h times, weekday arrays. Upstream's
  display strings ("5:15 PM - 6:00 PM") are for humans; this API's output gets joined
  against calendars and compared programmatically.
- **Fail loud, never guess.** Echo every name→id resolution; report `unmatched` and
  `ambiguous` inputs with candidates instead of silently dropping or picking. A filter
  upstream silently ignores must never be passed through — filter worker-side and say so.
- **Tiered cost.** `search_activities` is the cheap skim tier (grouped, stripped);
  `get_activity_detail` is the expensive drill tier (per-id fan-out). Don't let detail-tier
  data creep into search responses.

## Upstream etiquette

This rides an undocumented public API belonging to a public service. Read-only endpoints
only, modest fan-out, cache GETs. Never touch session/write paths (`/user/`, `/cart`,
enrollment). Free-tier Workers allow 50 subrequests/request — budget every fan-out
against that (it's why `get_activity_detail` caps ids at 12).

## Validation

- `cd worker && npm test` — vitest over the pure synthesis functions in `src/lib.js`
  (parsing, grouping, resolution, status derivation) with fixture payloads.
- `cd worker && npm run dev` then `node scripts/smoke.mjs` — live MCP smoke against
  `wrangler dev`: golden queries asserting invariants (names resolve, statuses present,
  response-size budgets), not exact rows — upstream data shifts daily.
- CI deploys `worker/` on push to main; there is no manual deploy step.
