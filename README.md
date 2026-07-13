# BOD Digest — hosted app

A real, standalone web app version of the Product & Engineering digest. Replaces the Cowork
artifact + Slack-canvas workaround entirely: this has its own server, its own database, and its
own Linear/Slack credentials, so it works as a normal shared web page — no Claude required to
view it, and no per-device state.

What it does:
- **Pull latest data** — click the button, it pulls fresh data from Linear + Slack for whatever
  date window you pick, and saves the result permanently.
- **Every pull is kept forever** — the history dropdown at the top lets anyone browse past pulls.
  Nothing is ever overwritten.
- **Callouts, Blockers, per-project notes, per-pod notes, and favorites are shared** — stored in
  the app's own database, visible to everyone with the link, editable by everyone, saved
  immediately. Other people's edits show up automatically (polls every 15s).
- **No login** — anyone with the URL can view and edit. There's no user accounts or permissions
  model here; if you need to restrict access later, put it behind your VPN or add a shared
  password (ask me to add this if you want it).

## 1. Get your credentials

**Linear API key**
1. Linear → Settings (gear icon) → Account → Security & access → Personal API keys → New API key.
2. Copy it — it starts with `lin_api_`. This acts as *your* Linear identity for API calls, so use
   an account that has access to the Engineering and Product teams.

**Slack bot token**
1. Go to https://api.slack.com/apps → Create New App → From scratch. Name it something like
   "BOD Digest", pick the givechariot workspace.
2. Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:
   `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`
   (the `groups:*` scopes are only needed if the shipping/product-ideas channels are private.)
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (starts with `xoxb-`).
4. In Slack, invite the bot into both channels it needs to read: the `#shipping` (or whatever
   your release-bot channel is) and `#product-ideas-and-feedback` channels — `/invite @BOD Digest`
   in each one.

## 2. Run it locally first (optional but recommended)

```bash
cd bod-digest-app
npm install
cp .env.example .env      # then fill in LINEAR_API_KEY and SLACK_BOT_TOKEN
node server.js
```

Open http://localhost:3000 — pick a date window and click **Pull latest data**. If it fails,
the error message will say which step broke (Linear auth, Slack auth, a bad channel ID, etc).

## 3. Deploy to Railway

1. Push this folder to a GitHub repo (or use the Railway CLI to deploy directly — `railway up`
   from inside this folder also works without GitHub).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Railway auto-detects Node from `package.json` and runs `npm start`. No Dockerfile needed.
4. **Add a Volume** (Railway project → your service → Settings → Volumes → New Volume). Mount it
   at `/data`. This is what makes your pulls and notes survive redeploys — without it, Railway's
   filesystem resets on every deploy and you'd lose everything.
5. **Set Variables** (Settings → Variables):
   - `LINEAR_API_KEY`
   - `SLACK_BOT_TOKEN`
   - `DATA_DIR` = `/data` (must match the volume mount path from step 4)
   - `ANTHROPIC_API_KEY` (optional, enables automatic triage theme grouping)
6. Deploy. Railway gives you a public URL (Settings → Networking → Generate Domain) — that's the
   link you share with the team. No Claude account needed on their end, just the URL.

## Customizing

Everything specific to Chariot's setup lives in `config.js`:
- `LINEAR_TEAMS` — which Linear teams to pull projects/issues from (default `Engineering`, `Product`)
- `COMPLETED_STATE_NAME` — the Linear workflow state name that counts as "done" (default `In Production`)
- `POD_ORDER` / `POD_FOUR` — the project labels used to group into pods
- `SHIPPING_CHANNEL_ID` / `PRODUCT_IDEAS_CHANNEL_ID` — Slack channel IDs to pull from

Edit these directly, or override the Slack channel IDs via environment variables of the same name
without touching code.

## How data is stored

`data/db.json` is a single JSON file holding every historical snapshot plus all shared notes and
favorites. It's intentionally simple (no database server to run/manage) — fine for a small
internal team tool. If this ever needs to handle heavy concurrent traffic, it can be swapped for
Postgres later without changing the front-end API.

## Notes on parity with the old artifact

This mirrors the original Cowork artifact's business logic (pod labels, current-cycle filtering,
"triage" = completed tickets with no project, release-message parsing, Linear-ticket resolution
from Slack threads) as closely as possible, but it has **not been run against your real Linear
and Slack data yet** — only tested against seeded mock data locally. After your first real pull,
sanity-check the KPI numbers and pod ticket counts against what you'd see directly in Linear, in
case something in your workspace (custom state names, differently-labeled projects, etc.) doesn't
match what this expects. `config.js` is the place to fix any mismatches.
