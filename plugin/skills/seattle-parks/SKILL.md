---
name: seattle-parks
description: "Find Seattle Parks & Rec activities — summer/seasonal camps, classes, swim/sports lessons, and drop-ins — filtered by a child's (or adult's) age, neighborhood, season, and keyword, with live registration prices and direct sign-up links. Use when someone wants to discover, compare, or sign up for Seattle Parks programs. Triggers: 'Seattle Parks', 'rec center activities', 'summer camps in Seattle', 'what can my kid sign up for', ActiveCommunities."
allowed-tools: mcp__seattle-activities__search_activities, mcp__seattle-activities__get_activity_prices
---

# Seattle Parks activity finder

Activities come from the **seattle-activities** connector (an MCP server over Seattle
Parks & Rec's ActiveCommunities catalog). It exposes two tools:

- `seattle-activities:search_activities` — search activities by age, neighborhood, season,
  keyword, and category.
- `seattle-activities:get_activity_prices` — look up the resident registration price for
  specific activities.

The tools' own parameter descriptions are authoritative for valid **season codes**,
**category IDs**, and filter options — pass the user's criteria through and rely on those
rather than guessing here.

> If these tools aren't available, tell the user to add the **seattle-activities** connector
> in their Claude settings (Settings → Connectors → Add custom connector →
> `https://seattle-activities.coryking.workers.dev/mcp`) before continuing.

## How to use this skill

You are the search interface — the user supplies the intent. Don't assume who it's for.

1. **Ask what they're looking for** if it isn't already clear: who it's for and their
   **age**, roughly **where in Seattle** (or which rec centers), the **season**, and any
   interest (sports, art, swim, etc.).
2. **Search** with `seattle-activities:search_activities`, translating their answer into the
   tool's parameters.
3. **Hand back a shortlist** grouped sensibly (e.g. camps / classes / drop-ins), each
   rendered as a card (see *Presenting results* below).
4. **Don't fetch prices.** Leave price off the cards until asked — see the guardrail.

**Always hide full activities.** Keep `exclude_full` at its default (`true`) — never show
activities with no open spots unless the user explicitly asks to see full ones too.

Field semantics in results: `open_spots` = number of open spots, `-1` = uncapped drop-in,
`0` = full (hidden by default). The age band is `[age_min_year, age_max_year)` —
`age_max_year` is **exclusive** (a "5-8yrs" activity comes back with `age_max_year` 9).

## Prices are on-demand only — never auto-populate them

Each price is a separate upstream call on a small free-tier worker, so do **not** price
search results, shortlists, or whole lists in the background. Call
`seattle-activities:get_activity_prices` **only** when the user explicitly asks what a
*specific* activity costs, and pass just that id (or the few they name). Surface it as a
follow-up offer — "want the price on any of these?" — rather than fetching prices yourself.
`price` is the resident fee as a string (e.g. `"$250.00"`); `free: true` means no charge.

## Presenting results (card format)

Render each activity as a short card. **The activity name is always a clickable link to its
Seattle Parks page** — use the result's `detail_url` (or `enroll_url`, which jumps straight
into enrollment). Never show a bare, unlinked name.

```
### [<Activity Name>](<detail_url>)
**Ages** <ages> · **When** <days> <time>, <dates> · **Where** <location>
**Spots** <open_spots> open  ·  **Price** <price, only if you fetched it>
<one-line summary from description>
```

Notes:
- For drop-ins (`open_spots: -1`), show "drop-in" instead of a spot count.
- Only show **Price** once you've fetched it for that activity — don't imply a price you
  don't have.
- Keep the description to a sentence; link out for the rest.

## Rec-center site IDs (helper for the `sites` parameter)

`search_activities` defaults to a central-Seattle cluster. To target specific rec centers,
pass their site IDs. Common central / close-in sites:

| ID | Site | ID | Site |
| --- | --- | --- | --- |
| 8 | Garfield Community Center | 29 | Miller Community Center |
| 399 | Yesler Community Center | 23 | Int'l District/Chinatown CC |
| 278 | Montlake Community Center | 110 | Cal Anderson Park |
| 16 | Medgar Evers Pool | 307 | Madison Pool |

Seattle has ~99 sites total across all neighborhoods (Ballard, West Seattle, Rainier,
Green Lake, etc.). If the user names a neighborhood you don't have an ID for, ask which rec
center they mean, or omit `sites` to search the default central cluster and note the
geography can be widened.
