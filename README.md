# Paintwatch

**Live site: https://tkalva2-source.github.io/**

A fan-made swatch book for 7TV name paints:
- Look up anyone's paints, badges, subscription and paint wall.
- See how to get any paint, and how many people are wearing it.
- Compare up to 6 collections.
- Get notified when the people you track unlock something new.

Not affiliated with 7TV, Twitch or Kick.

## What's in this repo

- `index.html`: the whole site. No build step.
- `tracker/check.mjs`: the always-on checker. A GitHub Action (`.github/workflows/check.yml`) runs it about every 15 minutes. Each run it:
  - announces new 7TV paints;
  - finds creators who get their own paint;
  - learns how paints are obtained;
  - refreshes the store and popularity data.
- `tracker/users.txt`: optional, empty by default. Twitch names listed here are also checked for unlocks.
- `data/`: written by the checker and read by the site.
  - `community.json`: wearing and owned counts.
  - `store.json`: this month's paints, the shop and the gift campaign.
  - `sources.json`: how each item is obtained.
  - `paints.json`: owner estimates.
  - `firsts.json`: creator paints.
  - `events.json`: the always-on feed.
  - `state.json`, `lastrun.json`, `leaderboard.json`, `owners.json`: the checker's bookkeeping.

## Updating the site

Commit and push to `main`. GitHub Pages republishes in a minute or two.

## Optional: Discord posts from the checker

The checker can post new paints and creator paints to a Discord channel.
1. In Discord, open **Server settings → Integrations → Webhooks** and copy a webhook URL.
2. In this repo, open **Settings → Secrets and variables → Actions** and add it as a secret named `DISCORD_WEBHOOK`.

Visitors never see this.

## Run locally

```bash
node tracker/check.mjs
```

```bash
node --test tracker/check.test.mjs
```

```bash
python -m http.server 8077
```

Then open http://localhost:8077. Set `PAINTWATCH_DEBUG=1` to print the Discord message instead of sending it.

## How accurate is it?

- **Profiles:** inventories, active paint and badge, roles, outfit history and subscription details come straight from 7TV's public API. Items 7TV marks as inaccessible aren't counted.
- **Dates:** when an item was added to 7TV, read from its ID. The public release can be a little later.
- **How to get a paint:**
  - "Get it now" comes live from 7TV's store data.
  - Past sources (monthly bundle, event, creator) come from a scan of 7TV's user directory that runs a little every check.
  - 7TV team accounts that own every paint are ignored as a source.
  - Paints nobody has been seen owning show "source not known yet".
- **Creator paints:** the account the paint is named after owns it, or 7TV's own event for it carries that name.
- **Wearing and owned counts:**
  - These come from PotatBotat (potat.app) via 7database.com, covering about 70,000 tracked users.
  - They only cover paints someone they track is wearing. For the rest, the site uses its own scan and says so.
  - The checker fetches them once per run, so visitors never call 7database directly.
- **Unlock times** are the window between two checks, because 7TV doesn't record when an item was unlocked. Paint and badge *switches* use 7TV's exact timestamps.
- **Upcoming** means added in the last 60 days with no known owner. 7TV doesn't publish release dates, so treat it as a strong hint, not a schedule.
- **Profile views** are counted by Abacus (abacus.jasoncameron.dev), a free public counter: once per visitor session, for fun, not proof.
- **Name lookups** use 7TV's own search, so Kick and Discord accounts work, with ivr.fi as the Twitch fallback.
- **No overall leaderboard:** 7TV has no complete public list of its ~2.9 million accounts, so a "top collectors" ranking can't be made accurate.

## Keeping the checker running

GitHub pauses scheduled workflows after 60 days with no repository activity. The checker's own commits normally count, but if it ever stops, re-enable it under **Actions**.

## Thanks

- 7TV and its paint artists.
- PotatBotat and 7database for the wearing stats.
- ivr.fi for Twitch lookups.
- Abacus for the view counter.
- Google Fonts.
- GitHub for hosting and Actions.
