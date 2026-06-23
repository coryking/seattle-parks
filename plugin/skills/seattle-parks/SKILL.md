---
name: seattle-parks
description: "Find Seattle Parks & Rec activities — summer/seasonal camps, classes, swim/sports lessons, and drop-ins — filtered by a child's (or adult's) age, neighborhood, season, and keyword, with live registration prices and direct sign-up links. Use when someone wants to discover, compare, or sign up for Seattle Parks programs. Triggers: 'Seattle Parks', 'rec center activities', 'summer camps in Seattle', 'what can my kid sign up for', ActiveCommunities."
---

# Seattle Parks activity finder

Seattle Parks & Rec runs registration through ActiveCommunities, whose search API is
POST-only and returns a large, noisy payload. This skill talks to a small public GET
proxy that filters and slims it down, so you can search activities and fetch prices
with plain `web_fetch`/`curl` GETs.

**Base URL:** `https://seattle-activities.coryking.workers.dev`

## How to use this skill

You are the search interface — the user supplies the intent. Don't assume who it's for.

1. **Ask what they're looking for** if it isn't already clear: who it's for and their
   **age**, roughly **where in Seattle** (or which rec centers), the **season**, and any
   interest (sports, art, swim, etc.).
2. **Search** with the `/` endpoint, translating their answer into query params.
3. **Hand back a shortlist** grouped sensibly (e.g. camps / classes / drop-ins), each
   rendered as a card (see *Presenting results* below).
4. **Only then fetch prices** for the few they're actually weighing — see the guardrail.

**Always hide full activities.** Keep `exclude_full` at its default (`true`) — never show
activities with no open spots unless the user explicitly asks to see full ones too.

## 1. Search activities

```
GET /?covers=8,9&season=51&sites=8,29&keyword=lego
```

Returns: `{ count, activities: [ { id, number, name, description, ages, age_min_year,
age_max_year, days, time, dates, date_start, date_end, open_spots, location, detail_url,
enroll_url } ] }`

| Param | Meaning |
| --- | --- |
| `covers` | comma list of ages the activity must actually serve, e.g. `8,9` — keeps it if its age band covers **any** listed age. Use this for a precise age fit. |
| `season` | `51`=Summer 2026, `52`=Fall 2026, `53`=School Year 2026-27 (also `48/49/50`=Fall25/Winter26/Spring26). Default `51`. |
| `sites` | comma list of rec-center/site IDs (see below). Omit for the default central-Seattle cluster. |
| `keyword` | free-text search (e.g. `basketball`, `art`, `dance`, `chess`). |
| `min_age` / `max_age` | numeric upstream age gate (coarser than `covers`). |
| `categories` | `22`=Camps, `23`=Performing Arts, `26`=Visual/Crafts, `27`=Athletics, `34`=Martial Arts, `35`=Nature, `38`=Enrichment. |
| `exclude_full` | drop activities with no open spots. Default **true**; pass `false` to include full ones. |
| `no_swim` | drop pool/swim/dive activities. Default **true**; pass `false` to include them. |
| `pretty` | indent the JSON (default off; compact saves tokens). |

Field semantics: `open_spots` = number of open spots, `-1` = uncapped drop-in, `0` = full
(filtered out by default). `age_max_year` is **exclusive** — "less than 9" comes through as
`9` and means up to age 8.

Add `/help` to the URL for the full parameter reference.

## 2. Prices (a separate, rate-limited fetch)

```
GET /price?ids=84263,85421,83719
```

Returns `{ count, prices: [ { id, free, price } ] }` — `price` is the **resident**
registration fee as a string (e.g. `"$250.00"`); `free: true` means no charge.

> **Guardrail — do not over-fetch prices.** Prices are deliberately *not* in the search
> results. The proxy makes **one upstream request per id**, and it runs on a platform with
> a per-request subrequest limit. Only call `/price` for the handful the user is seriously
> considering — **a shortlist of roughly ≤10 ids in one call**, never the whole result set.
> If they want "everything," price the top few and offer to price more on request.

## Opening / signing up for an activity

Every result has a numeric `id`. Build the live Seattle Parks page for any activity from it:

```
https://anc.apm.activecommunities.com/seattle/activity/search/detail/<id>?onlineSiteId=0&from_original_cui=true
```

e.g. `id` 86074 → `https://anc.apm.activecommunities.com/seattle/activity/search/detail/86074?onlineSiteId=0&from_original_cui=true`

That page has full details and the register button. The JSON also gives `enroll_url`
(jumps straight into enrollment) and `detail_url` (an alternate link to the same page).

## Presenting results (card format)

Render each activity as a short card. **The activity name is always a clickable link to
its Seattle Parks page** (the `detail/<id>` URL above) — never show a bare, unlinked name.

```
### [<Activity Name>](https://anc.apm.activecommunities.com/seattle/activity/search/detail/<id>?onlineSiteId=0&from_original_cui=true)
**Ages** <ages> · **When** <days> <time>, <dates> · **Where** <location>
**Spots** <open_spots> open  ·  **Price** <price, only if you fetched it>
<one-line summary from description>
```

Notes:
- For drop-ins (`open_spots: -1`), show "drop-in" instead of a spot count.
- Only show **Price** once you've fetched it for that activity — don't imply a price you
  don't have.
- Keep the description to a sentence; link out for the rest.

## Rec-center site IDs

Common central / close-in Seattle sites (pass via `sites=`):

| ID | Site | ID | Site |
| --- | --- | --- | --- |
| 8 | Garfield Community Center | 29 | Miller Community Center |
| 399 | Yesler Community Center | 23 | Int'l District/Chinatown CC |
| 278 | Montlake Community Center | 110 | Cal Anderson Park |
| 16 | Medgar Evers Pool | 307 | Madison Pool |

Seattle has ~99 sites total across all neighborhoods (Ballard, West Seattle, Rainier,
Green Lake, etc.). If the user names a neighborhood you don't have an ID for, ask them
which rec center they mean, or omit `sites` to search the default central cluster and
note that the geography can be widened.
