# ActiveCommunities (ActiveNet) internal REST API

Reference for the private REST API behind Seattle Parks & Rec's registration site. This is
the API the `worker/` MCP server is built on. It is undocumented and unversioned by the
vendor; everything here was derived by driving the site with a browser, statically
extracting the SPA's endpoint table, and replaying calls with `curl`.

**Base:** `https://anc.apm.activecommunities.com/{tenant}/rest/...`

Seattle's tenant slug is `seattle`. All paths below omit the base.

## The single most important fact

**Every read endpoint listed under "Verified cookieless" works with no cookies, no session,
and no CSRF token.** The SPA sends an `x-csrf-token` header, but the server does not
require it for reads. A stateless Cloudflare Worker can call these directly.

Anything under `/user/`, `/myaccount/`, `/cart`, `/checkout`, `/activity/enrollment*`,
`/reservation/form*`, `/wishlist`, or `/order` is session-bound and out of scope — those
are the write/registration paths and require login.

## Multi-tenancy

This is one shared platform. The tenant slug is the only thing that changes; schemas,
request bodies, and field names are identical across deployments. Verified against three:

| Tenant | Slug | Activities | Facilities | Drop-in calendars | Passes |
|---|---|---|---|---|---|
| Seattle Parks & Rec | `seattle` | 3,656 | 828 | 7 | 14 |
| SF Rec & Park | `sfrecpark` | 1,154 | 307 | 2 | 20 |
| Snohomish County | `snoco` | 1 | 0 | 3 | 0 |

Implications:

- A tenant-parameterized worker is nearly free — take the slug as a config value.
- Which *facets* a tenant populates varies. Seattle uses `sites` (98) and `geographicareas`;
  `sfrecpark` returns zero sites. Never assume a facet is non-empty; read it from
  `activities/filters`.
- Guessing slugs mostly fails (`tacoma`, `kingcounty`, `bellevuewa` are not tenants — they
  return an HTML 404, so JSON parsing blows up rather than returning an error envelope).
- `snoco` is a near-dormant deployment. It is a good shape-check target, not a data target.

## Request conventions

Reads are a mix of `GET` with query params and `POST` with a JSON body. The POST search
endpoints are POST-only — there is no GET equivalent.

Headers that matter:

```
X-Requested-With: XMLHttpRequest      # required-ish; send it always
Referer: https://anc.apm.activecommunities.com/{tenant}/<a matching UI page>
Content-Type: application/json;charset=utf-8    # on POSTs
page_info: {"page_number":1,"total_records_per_page":20}   # paging, as a HEADER not a body field
User-Agent: <any normal browser UA>
```

`locale=en-US` belongs on the query string of essentially every call. The SPA also appends a
cache-busting `ui_random=<epoch_ms>`; it is not required.

**Paging is carried in a `page_info` request header**, which is unusual and easy to miss.

### Response envelope

Every response is wrapped:

```json
{
  "headers": {
    "response_code": "0000",
    "response_message": "Successful",
    "page_info": { "total_records": 3656, "total_page": 183, "page_number": 1,
                   "total_records_per_page": 20, "order_by": "Name", "order_option": "ASC" }
  },
  "body": { ... }
}
```

`headers.page_info.total_records` is the authoritative result count for activity search.
Note the HTTP status is **200 even for errors** — you must check `response_code`:

| Code | Meaning |
|---|---|
| `0000` | Successful |
| `0001` | No result found |
| `0008` | No license — the tenant has not licensed that module |
| `1043` | Invalid date times |

HTTP `202` is returned by `common/logincheck` for an anonymous caller. HTTP `302` means the
endpoint is login-gated and is redirecting to sign-in.

## Verified cookieless — activities

### `POST /activities/list?locale=en-US`

The main catalog search. Body is `{"activity_search_pattern":{...},"activity_transfer_pattern":{}}`.
Paging via the `page_info` header; `total_records_per_page` of 50 is honored here.

Useful `activity_search_pattern` fields: `activity_keyword`, `min_age`, `max_age`,
`center_ids[]`, `site_ids[]`, `geographic_area_ids[]`, `activity_category_ids[]`,
`activity_other_category_ids[]`, `season_ids[]`, `activity_type_ids[]`, `instructor_ids[]`,
`days_of_week_ids[]`, `date_after`, `date_before`, `time_after_str`, `time_before_str`,
`open_spots`, `custom_price_from`, `custom_price_to`, `for_map`, `activity_select_param`.

The response body carries **both** `activity_items` and a full `filters` facet block, so a
single search call also returns the entire facet vocabulary — you rarely need a separate
`activities/filters` call. Facets are `{id, desc}` lists **without counts**; there is no
faceted-count aggregation anywhere in this API.

Per-item fields worth knowing: `id`, `name`, `desc` (HTML), `ages` / `age_min_year` /
`age_max_year` (max is exclusive), `location.label`, `date_range_description`, `time_range`,
`days_of_week`, `openings`, `total_open`, `already_enrolled`, `number` (the public course
number), `detail_url`, `action_link.href` (the enroll URL), and `fee.href`.

### `POST /activities/map?locale=en-US`

Same body shape with `for_map: true`. **The only aggregation endpoint in the API.** Returns
`map_points[]`, each a location rollup: `center_name`, `latitude`, `longitude`,
`item_count` (the true count at that location), and `items[]` — but `items` is a **preview
capped at 3 entries** regardless of `item_count`. Unpaginated: one call returns every
matching location.

This is the "group by location" primitive — e.g. "which pools have kid swim lessons, and how
many at each" is one call.

### `GET /activities/filters?locale=en-US`

Standalone facet vocabulary: sites, centers, geographicareas, skills, instructors, seasons,
terms, categories, othercategories, types, departments, plus `enable_*_filter` booleans that
tell you which facets the tenant actually uses.

### `GET /activities/locations/search?locale=en-US`

`geographicareas`, `centers`, `sites` — the location vocabulary for search filters.

### Activity detail family (all `GET`, all keyed by activity id)

| Path | Carries |
|---|---|
| `/activity/detail/{id}?locale=en-US` | Full detail: description, fees, location, notes |
| `/activity/detail/meetingandregistrationdates/{id}` | Schedule patterns + enrollment open/close datetimes |
| `/activity/detail/estimateprice/{id}` | Price |
| `/activity/detail/detaildate/{id}` | Meeting-date detail |
| `/activity/detail/buttonstatus/{id}` | Registration button state + the "why you can't register" notification text |
| `/activity/detail/packagelist/{id}` | Package bundles this activity belongs to |

`buttonstatus` is the honest answer to "can I actually sign up for this right now" — it
returns `action_link`, `activity_online_start_time`, `time_remaining`, and a human-readable
`notification` (e.g. *"online registration is not allowed for this activity"*).

### `POST /activities/subs/{activityId}?locale=en-US`

Sub-activities of a parent activity. **Seattle does not use this feature** — scanning 1,200
activities found zero with `parent_activity: true` or `num_of_sub_activities > 0`. Listed for
completeness; do not build on it for Seattle.

## Verified cookieless — drop-in calendars

This is the richest under-used data in the API: concrete, dated drop-in sessions across every
community center. Seattle exposes 7 calendars: Adult, Multiple-Ages, Senior, Swimming, Tot,
Tween/Teen, Youth.

### `GET /onlinecalendar/calendars?locale=en-US`

Lists the calendars with `calendar_id`, `name`, `min_time`/`max_time`, `first_day`.

### `POST /onlinecalendar/filters?locale=en-US`

Body: `{"calendar_id": 8}`. Returns the filter vocabulary *for that calendar*: `center` (the
14 centers with drop-in programming), `activity` (every drop-in activity with its
`category_id` / `sub_category_id` / `center_ids`), `activity_category`,
`activity_sub_category`, `facilities`, `event_types`, `calendar_period`.

### `POST /onlinecalendar/multicenter/events?locale=en-US`

The payoff. Body:

```json
{"calendar_id":8,"center_ids":[7,9,157,23,270,24,452,294,28,306,347,29,414,229],
 "display_all":0,"search_start_time":"","search_end_time":"",
 "facility_ids":[],"activity_category_ids":[],"activity_sub_category_ids":[],
 "activity_ids":[],"activity_min_age":null,"activity_max_age":null,"event_type_ids":[]}
```

One call with all 14 center ids returns **538 dated drop-in sessions** grouped as
`center_events[] -> events[]`. Each event has `title`, `start_time`, `end_time` (concrete
datetimes, one entry per occurrence), `description`, `event_item_id`, `activity_detail_url`,
`facilities[]`, and a `price` block.

**Gotcha:** `search_start_time` and `search_end_time` are **ignored**. The server always
returns a fixed rolling window — roughly a few days back through ~5 weeks ahead (observed
2026-08-10 → 2026-09-19, 35 distinct dates). Requesting October returns the same window.
Filter by date client-side. Upside: no pagination, no date-walking — one request gets the
whole window for the whole city.

### `GET /onlinecalendar/centerdetails?center_ids=7,9&locale=en-US` and `/onlinecalendar/centerdetails/{centerId}`

Center directory: address, city, state, zip, phone, plus per-weekday open/close times and
`*_closed` flags. This is the closest thing to a **community-center hours directory**.
(Seattle leaves the day times as the `1899-12-30` sentinel, i.e. unpopulated.)

### `GET /onlinecalendar/eventdetails/{eventItemId}` and `/onlinecalendar/activity-details/{activityId}?selected_date=YYYY-MM-DD%20HH:MM:SS`

Detail for a single calendar occurrence.

## Verified cookieless — facilities & reservations

### `POST /reservation/resource?locale=en-US`

Facility search — 828 reservable facilities in Seattle. Body:

```json
{"name":"","attendee":0,"date_times":[],"event_type_ids":[],"facility_type_ids":[],
 "reservation_group_ids":[],"amenity_ids":[],"facility_id":0,"equipment_id":0,
 "center_id":0,"center_ids":[],"resource_type":0,"client_coordinate":"",
 "order_by_field":"name","order_direction":"asc","page_size":20,"start_index":0,
 "search_client_id":"","date_time_length":null,"full_day_booking":false,
 "specify_start_and_end_times":false}
```

Returns `items[]` with `id`, `name`, `type_name`, `center_id`, `center_name`, `max_capacity`,
`reserve_by`, `no_internet_permits`, `event_type_list[]`, plus `total` and `next_start_index`.

Three capabilities worth calling out:

**Availability window search.** Set `specify_start_and_end_times: true` and

```json
"date_times":[{"from_date_time":"2026-08-22 14:00:00","to_date_time":"2026-08-22 16:00:00"}]
```

and the result set narrows to facilities **actually free in that window**, each tagged
`"availability": "Available"`. This answers "what can I book Saturday 2–4pm". The key names
are `from_date_time` / `to_date_time` — nothing else works, and the format is
`YYYY-MM-DD HH:MM:SS` with a space. An ISO `T` separator returns `1043 Invalid date times`.
When date filtering is active, `total` comes back as `-1`.

**Geo-proximity.** `client_coordinate: "47.6118,-122.3274"` with
`order_by_field: "distance"` sorts by distance from a point and populates each item's
`distance`.

**Paging.** `page_size` in the body is ignored and the `page_info` header cannot raise it —
the server hard-caps at **20 results per page**. Page with `start_index`, following
`next_start_index`. A full dump of Seattle's 828 facilities is 42 sequential requests.

**Keyword gotcha:** the `name` field does *not* do a plain substring match on the facility
name. `"Alki"` → 27, `"tennis"` → 140 (including "AYTC Indoor Court #02", which lacks the
word — so it also matches center and type), `"Beach Park"` → 35. But `"pool"`, `"Pool"`,
`"gym"`, and `"Evans"` all → **0**, even though `Evans Pool Lane #4` exists as facility 173.
Matching is not case-sensitive but is otherwise unpredictable. Prefer filtering by
`center_ids` / `facility_type_ids` from `option/filteroptions` over keyword search.

**Two disjoint facility universes.** The 828 searchable facilities are the *reservable*
ones. Facilities referenced by activities (e.g. `Evans Pool Lane #4`, id 173) may not appear
in search at all, yet are fetchable directly by id via `simple/detail`. Never assume a
facility id from an activity is findable through facility search.

### `GET /reservation/resource/availability/daily/{resourceId}?start_date=&end_date=&customer_id=0&company_id=0&event_type_id=-1&attendee=1&no_cache=true&locale=en-US`

Per-facility daily availability. Returns `daily_details[]`, one entry per date, each with a
`status` and a `times[]` list of `{start_time, end_time, available, is_cross_day}` windows.
Honors an arbitrary `start_date`/`end_date` range (unlike the drop-in calendar). This is the
real booking-availability calendar.

### Facility detail

| Path | Notes |
|---|---|
| `GET /reservation/resource/simple/detail/{facilityId}` | Works for facilities not in search. Address, phone, center, capacity, supervisor, `opening_hours[]`, `advanced_restrictions[]` (e.g. "Residents can make reservations at least 7 day(s) in advance"), `amenities[]`, parent/child facility overlaps |
| `GET /reservation/resource/detail/{facilityId}?event_type_ids=` | Fuller detail used by the booking flow |
| `GET /reservation/resource/getFeeDescriptionByFacilityId/{facilityId}` | Fee description |
| `GET /reservation/resource/option/filteroptions` | Facet vocabulary: `centers`, `facility_types`, `amenities`, `event_types`, `reservation_groups` |
| `GET /reservation/resource/searchoptions?keyWord=pool` | Typeahead (~46KB); resolves a phrase to facility/center ids |
| `GET /reservation/resource/locationmapsearchoptions` | Location-map search options |
| `GET /reservation/landingpage/facilitygroups` | Facility groupings |

`POST /reservation/resource/facilitiesavailability` is the location-map status call
(`fetchLocationMapStatus` in the bundle) — availability status for a set of facilities drawn
on a map.

## Verified cookieless — passes / memberships

### `POST /membership/packages?locale=en-US`

Body: `{"keyword":"","category_ids":[],"package_type_ids":[],"min_age":null,"max_age":null,"site_ids":[],"center_ids":[]}`

Returns `package_list[]` — 14 for Seattle. Each: `id`, `name`, `category_name`,
`description`, `expiration_description`, `uses_description`, `age_description`,
`type_description`, `primary_fee`, `membership_sale_page_url`. This is the full public
pass/pricing catalog (e.g. "30 Day Unlimited Swim Pass", $91.50) in a single call.

### `GET /membership/search/filters?locale=en-US`

~54KB of facet vocabulary: centers, categories, package types, sites, defaults.

### `GET /membership/packages/{packageId}` and `/membership/detail/estimateprice/{packageId}`

Per-package detail and price.

## Verified cookieless — infrastructure / misc

| Path | Notes |
|---|---|
| `GET /common/logincheck` | Returns HTTP 202 anonymously. Harmless |
| `GET /configuration` | Site configuration |
| `GET /homepage/homesetting` | Homepage layout/config |
| `GET /homepage/searchbaroptions` | Search bar options |
| `GET /basedata/terms` | Term vocabulary |
| `GET /faq` | FAQ content (~13KB) |
| `GET /public-contents/0` and `/public-contents/1` | Public content blocks |
| `GET /customerheaderfooter/{pageId}` | Per-page header/footer content |
| `GET /address/suggest?key={keyword}` and `/address/candidate?key={magicKey}` | Address autocomplete/geocode |
| `GET /organization/captivate/{ios\|android}/app-info` | Mobile app info. Seattle returns `show_captivate_download_url: false` — **no mobile app** |

## Not available

- **No GraphQL.** Zero occurrences in the SPA bundle. REST only.
- **No bulk export / no `?format=csv`.** Pagination is the only path to a full dump.
- **No faceted counts.** Facets are plain `{id, desc}` lists. `activities/map`'s
  `item_count` is the sole count-by-group in the entire API.
- **No mobile app** for Seattle (ActiveNet's white-label app is "Captivate").
- **Leagues module is unlicensed.** `GET /leagues/list` returns `0008 No license`. The whole
  `/leagues/*` family (standings, brackets, pairings, team schedules) exists in the platform
  but is dark for Seattle. This is a licensing gap, not an auth gap — signing in will not
  help.
- **`GET /reservation/landingpage/eventtypes`** returns `0001 No result found`.
- **`GET /system/version`** and **`GET /grades`** redirect (302) — login-gated.
- **No "program" grouping in Seattle's data.** See below.

## On "programs" (grouping activities across dates/facilities)

There is no first-class "program" object that aggregates, say, all Adult Swim Lessons across
pools and terms. What exists:

1. **Parent / sub-activities** — the platform's real grouping feature
   (`parent_activity`, `num_of_sub_activities`, `sub_activity_ids`, `POST /activities/subs/{id}`).
   **Seattle populates none of it** (0 of 1,200 scanned).
2. **`/rest/program/*`** — a different concept entirely. These back the `daycare/program/:programId`
   routes (childcare/preschool with sessions and participants), not a catalog grouping.
3. **Packages** — `activity/detail/packagelist/{id}` and `membership/packages`. Bundles sold
   together, not a taxonomy.
4. **Categories / sub-categories / other-categories** — the actual working taxonomy, returned
   as facets with every search.

So a "program" view has to be **synthesized client-side**. The practical recipe for a query
like *"find kid swim lessons"*:

- `POST /activities/list` with `activity_keyword` + `min_age`/`max_age` → 33 results for
  "swim lesson" ages 6–10. Age band is `[age_min_year, age_max_year)`, max exclusive.
- Group the results by `name` (Seattle names sections consistently — "Learn To Swim -
  Personal Lesson 1 on 1" recurs across Meadowbrook and Madison pools) and/or by
  `location.label`.
- Or `POST /activities/map` for the location rollup with per-location counts in one call.

Grouping by `name` is the closest thing to a program abstraction, and it is a worker-side
concern.

## Implications for the worker

`worker/src/index.js` currently uses exactly two endpoints — `activities/list` and
`activity/detail/estimateprice/{id}`. The highest-value unexploited surface, roughly in order:

1. **Drop-in calendar** (`onlinecalendar/multicenter/events`) — 538 dated sessions in one
   cookieless call. Answers "what can I drop into at Green Lake this Saturday", which the
   activity catalog answers poorly. No paging, no auth.
2. **Facility availability window search** (`reservation/resource` with `date_times`) —
   "what's bookable Saturday 2–4pm", plus geo-sorting by `client_coordinate`.
3. **Per-facility availability calendar** (`reservation/resource/availability/daily/{id}`) —
   honors real date ranges.
4. **Passes catalog** (`membership/packages`) — the entire pricing catalog in one call.
5. **`activity/detail/buttonstatus/{id}`** — the truthful "can I register" answer, including
   registration open time and the reason when the answer is no.
6. **`activities/map`** — cheap location rollups with counts, good for "near me" summaries.

Design notes: cache aggressively (this data changes daily at most); always check
`response_code` rather than HTTP status; respect the 20/page facility cap; and keep the
tenant slug configurable since the API is identical across municipalities.

## Regenerating the endpoint inventory

The complete server-side API surface is statically extractable from the SPA bundle — the app
registers every endpoint through a single `createAPI(HttpMethod.X, url)` factory. This
recipe survives bundle-hash changes and yields ~488 endpoint definitions.

```bash
# 1. Find the current bundle hash (an <script> src on any page)
curl -s "https://anc.apm.activecommunities.com/seattle/activity/search" \
  | grep -oE 'app\.index\.[a-f0-9]+\.js'

# 2. Download it (~11MB)
curl -s -o app.index.js "https://akamai-anc.apm.activecommunities.com/seattle/js/app.index.<hash>.js"

# 3. Extract method + path pairs
grep -oE 'HttpMethod\.[A-Z]+,"?"?\.?concat\([a-zA-Z_$]+,"[^"]+"' app.index.js \
  | sed -E 's/HttpMethod\.([A-Z]+),.*concat\([a-zA-Z_$]+,"([^"]+)"/\1 \2/' \
  | sort -u
```

Paths are assembled from a prefix variable, so a few come out as bare fragments (`/list`,
`/map`, `/filters` are all under `/rest/activities`). To resolve prefixes, look for the
enclosing module definition:

```bash
grep -oE '.{300}HttpMethod\.POST,"?"?\.?concat\([a-zA-Z_$]+,"/map"\)' app.index.js
# => r="".concat(window.__siteBaseName,"/rest"), i="".concat(r,"/activities") ...
```

SPA routes (useful for finding pages that trigger unexplored endpoints) come from:

```bash
grep -oE 'path:"[^"]*"' app.index.js | sort -u
```
