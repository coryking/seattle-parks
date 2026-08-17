# seattle-parks

Search recreation catalogs on the ActiveCommunities (ActiveNet) platform — Seattle Parks &
Rec by default, ~100 other cities/districts via an `org` parameter — as MCP tools: program
search with age/season/site filters, drop-in session calendars, registration windows and
"can I actually sign up right now" verdicts, and prices (with raw fee tiers when no single fee applies).

The platform's own API is POST-only, page-shaped for its web UI, and undocumented
(reverse-engineered reference: [`docs/activenet-api.md`](docs/activenet-api.md)). This
repo's Cloudflare Worker re-exposes it as a remote **MCP server** designed for LLM
consumers: grouped, structured, summary-first responses; human names resolved server-side;
nothing silently dropped.

- **`worker/`** — the MCP server (Streamable HTTP at `/mcp`). Live at
  `https://seattle-activities.coryking.workers.dev/mcp`.
- **`plugin/`** — a minimal Claude Code plugin that just registers the connector (this repo
  is its own plugin marketplace). All behavior lives in the server's tool schemas and
  instructions — the plugin intentionally carries none.

## Install

### claude.ai (web + desktop)

**Settings → Connectors → Add custom connector**, and paste:

```
https://seattle-activities.coryking.workers.dev/mcp
```

Then ask, e.g. *"find fall swim lessons for an 8-year-old at Evans Pool."*

### Claude Code

Either add the connector directly:

```
claude mcp add --transport http seattle-activities https://seattle-activities.coryking.workers.dev/mcp
```

or install the plugin (same thing, marketplace-managed):

```
/plugin marketplace add coryking/seattle-parks
/plugin install seattle-parks@coryking
```

### Any MCP client

```
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP   URL: https://seattle-activities.coryking.workers.dev/mcp
```

## Tools

`search_activities` (grouped program summaries), `get_activity_detail` (registration
window + enrollability verdict + schedule + price for a shortlist), `search_dropins`
(dated drop-in sessions), `get_filters` (an org's sites/seasons/categories), `list_orgs`
(known ActiveCommunities tenants). Parameter docs live in the tool schemas themselves —
they are the single authoritative interface documentation.

## Develop

```
cd worker
npm ci
npm test                       # vitest over the pure synthesis functions
npm run dev                    # wrangler dev on :8787
node ../scripts/smoke.mjs      # golden-query smoke against the dev server
```

Deploys run in CI: pushes under `worker/**` to `main` run the tests, deploy via
`cloudflare/wrangler-action` (needs the `CLOUDFLARE_API_TOKEN` secret and
`CLOUDFLARE_ACCOUNT_ID` variable), then smoke the live deployment. The deployed
`serverInfo.version` is auto-stamped from `package.json` plus the CI run.

## License

MIT
