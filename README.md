# seattle-parks

Find Seattle Parks & Rec activities — camps, classes, lessons, drop-ins — by age,
neighborhood, season, and keyword, with live registration prices and direct sign-up links.

Seattle Parks registers through ActiveCommunities, whose search API is POST-only and
returns a large, noisy payload. This repo is two things that live together:

- **`worker/`** — a small Cloudflare Worker that shims the POST-only catalog into clean
  GET endpoints (filtered, slimmed, CORS-on). Deployed at
  `https://seattle-activities.coryking.workers.dev`.
- **`plugin/`** — a Claude Code plugin whose skill teaches a model how to use those
  endpoints. This repo is also its own plugin marketplace.

## Install

The skill is one portable `SKILL.md`, so it works on every surface that supports Agent
Skills. Pick yours:

### Claude Code

```
/plugin marketplace add coryking/seattle-parks
/plugin install seattle-parks@seattle-parks
```

Then just ask, e.g. *"find Seattle Parks summer camps for a 7-year-old near Ballard."*
Update later with `/plugin marketplace update seattle-parks`.

### claude.ai (web + desktop)

claude.ai can add this repo as a marketplace directly — same as Claude Code:

1. **Settings → Capabilities → enable Code execution** (required before plugins appear).
2. **Customize → Plugins → "Personal" → "+" → Add marketplace** and paste the repo URL:
   `https://github.com/coryking/seattle-parks`
3. Install the **seattle-parks** plugin from the marketplace.

> Prefer a standalone skill instead of the plugin? Download `seattle-parks.zip` from the
> [latest release](https://github.com/coryking/seattle-parks/releases/latest) and use
> **Customize → Skills → Upload a skill**.

### ChatGPT

Skills use the same open Agent Skills standard. Add `plugin/skills/seattle-parks/SKILL.md`
as a skill (currently the Business/Enterprise/Edu beta).

## The API directly

```
# Search (age-filtered, open spots only, no swim by default)
curl 'https://seattle-activities.coryking.workers.dev/?covers=8,9'

# Price for a specific activity (resident fee; fetch on-demand, not in bulk)
curl 'https://seattle-activities.coryking.workers.dev/price?ids=84263'

# Full parameter reference
curl 'https://seattle-activities.coryking.workers.dev/help'
```

See `plugin/skills/seattle-parks/SKILL.md` for the full parameter list and field
semantics.

## Develop / deploy the worker

Deploys run in CI: pushing changes under `worker/**` to `main` triggers
[`.github/workflows/deploy-worker.yml`](.github/workflows/deploy-worker.yml), which
deploys to `*.workers.dev` via `cloudflare/wrangler-action`. It needs a
`CLOUDFLARE_API_TOKEN` repo secret (Workers Scripts → Edit); `account_id` lives in
`worker/wrangler.toml`. You can also run it by hand from the Actions tab
(workflow_dispatch).

For a local check without deploying:

```
cd worker
npx wrangler deploy --dry-run   # bundle + validate
```

## License

MIT
