# seattle-parks

Find Seattle Parks & Rec activities — camps, classes, lessons, drop-ins — by age,
neighborhood, season, and keyword, with live registration prices and direct sign-up links.

Seattle Parks registers through ActiveCommunities, whose search API is POST-only and
returns a large, noisy payload. This repo is two things that live together:

- **`worker/`** — a Cloudflare Worker that exposes the POST-only catalog as a remote
  **MCP server** (Model Context Protocol over Streamable HTTP at `/mcp`). MCP clients reach
  it server-side, so there's no code-execution egress allowlist to configure. Endpoint:
  `https://seattle-activities.coryking.workers.dev/mcp`.
- **`plugin/`** — a Claude Code plugin whose skill adds workflow + presentation guidance on
  top of those MCP tools. This repo is also its own plugin marketplace.

## Install

Two parts: the **MCP connector** (the worker — provides the tools) and the optional
**skill** (workflow + presentation guidance). Connect the first everywhere; add the second
where you want richer behavior.

### claude.ai (web + desktop)

**Settings → Connectors → Add custom connector**, and paste the MCP URL:

```
https://seattle-activities.coryking.workers.dev/mcp
```

That's all you need to search — Claude calls the connector's tools directly. Then ask, e.g.
*"find Seattle Parks summer camps for a 7-year-old near Ballard."*

Optional skill: **Settings → Capabilities → enable Code execution**, then **Customize →
Plugins → "Personal" → "+" → Add marketplace** → `https://github.com/coryking/seattle-parks`
→ install **seattle-parks**. (Or upload the standalone skill: download `seattle-parks.zip`
from the [latest release](https://github.com/coryking/seattle-parks/releases/latest) and use
**Customize → Skills → Upload a skill**.)

### Claude Code

```
# the MCP connector (the tools)
claude mcp add --transport http seattle-activities https://seattle-activities.coryking.workers.dev/mcp

# the skill (optional guidance), from this repo's marketplace
/plugin marketplace add coryking/seattle-parks
/plugin install seattle-parks@coryking
```

Update the skill later with `/plugin marketplace update coryking`.

## The MCP server directly

The worker speaks MCP over Streamable HTTP at `/mcp` — point any MCP client at it, or poke
it with the inspector:

```
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP   URL: https://seattle-activities.coryking.workers.dev/mcp
```

Tools: `search_activities` (filter by age, neighborhood, season, keyword, category) and
`get_activity_prices` (resident fee for specific activity ids — on-demand, not in bulk).
Parameter docs live in the tool descriptions; `plugin/skills/seattle-parks/SKILL.md` carries
the workflow and field semantics.

## Develop / deploy the worker

Deploys run in CI: pushing changes under `worker/**` to `main` triggers
[`.github/workflows/deploy-worker.yml`](.github/workflows/deploy-worker.yml), which runs
`npm ci` and deploys to `*.workers.dev` via `cloudflare/wrangler-action`. It needs a
`CLOUDFLARE_API_TOKEN` repo secret (Workers Scripts → Edit) and the `CLOUDFLARE_ACCOUNT_ID`
repo variable. The deployed `serverInfo.version` is auto-stamped from the `package.json`
base plus the CI run number and commit. You can also run it by hand from the Actions tab
(workflow_dispatch).

For a local check without deploying:

```
cd worker
npm ci
npx wrangler dev               # run locally; POST MCP to http://127.0.0.1:8787/mcp
npx wrangler deploy --dry-run  # bundle + validate
```

## License

MIT
