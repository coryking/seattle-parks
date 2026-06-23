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

## Use the skill (Claude Code)

```
/plugin marketplace add coryking/seattle-parks
/plugin install seattle-parks@seattle-parks
```

The same `plugin/skills/seattle-parks/SKILL.md` is portable: zip the `seattle-parks`
skill folder and upload it under **Customize → Skills** in claude.ai (needs code
execution enabled), or use it as an Agent Skill in ChatGPT — the format is shared.

## The API directly

```
# Search (age-filtered, open spots only, no swim by default)
curl 'https://seattle-activities.coryking.workers.dev/?covers=8,9'

# Prices for a shortlist (resident fee; keep batches small)
curl 'https://seattle-activities.coryking.workers.dev/price?ids=84263,85421'

# Full parameter reference
curl 'https://seattle-activities.coryking.workers.dev/help'
```

See `plugin/skills/seattle-parks/SKILL.md` for the full parameter list and field
semantics.

## Develop / deploy the worker

```
cd worker
./deploy.sh --dry-run   # bundle + validate
./deploy.sh             # deploy (auth via the wrangler credential shim)
```

## License

MIT
