# Paintwatch

Look up anyone's 7TV paints and badges, browse every cosmetic, rank streamers on a leaderboard, and get notified when people unlock something new.

- `index.html`: the whole site. No build step.
- `tracker/check.mjs`: the always-on checker. A GitHub Action runs it about every 15 minutes.
- `tracker/users.txt`: optional, and empty by default. People listed here also get "X unlocked Y" posts. Without it, the checker announces every new paint and finds creators who get their own paint.
- `data/`: written by the checker. The site reads it.
  - `leaderboard.json`
  - `events.json`: unlocks
  - `owners.json`: how many tracked streamers own each paint
  - `state.json`
  - `lastrun.json`

## Put it online (GitHub Pages)

1. Create a GitHub repository and push this folder to it.
2. Turn on the website: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / root → Save**.
   It goes live at `https://<you>.github.io/<repo>/`.
3. Turn on Discord alerts (optional):
   - In Discord, open **Server settings → Integrations → Webhooks → New Webhook** and copy its URL.
   - In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
   - Name the secret `DISCORD_WEBHOOK` and paste the URL.
4. Start the first check: **Actions → Check 7TV unlocks → Run workflow**.
   After that it runs on its own about every 15 minutes. GitHub can run scheduled jobs late when it's busy.

The first run only records a starting point for each user. Unlocks are reported from the second run on.

## Change who is tracked

Edit `tracker/users.txt` on GitHub. The next run picks it up. Accounts that aren't linked to 7TV are skipped and named in the run log.

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

Then open http://localhost:8077. To see the Discord message without sending it, set `PAINTWATCH_DEBUG=1`.

## How accurate is it?

- Inventories, active paints and badges, roles and outfit history come straight from 7TV's public API. Entries 7TV marks as inaccessible are not counted.
- Item dates are when the item was added to 7TV, read from its ID. The public release can be a little later.
- "Monthly sub bundles" counts distinct monthly paint bundles owned. It roughly matches months subscribed but isn't exact.
- **How to get a paint:**
  - "Get it now" comes straight from 7TV's store API: this month's subscriber paints, shop items with prices, and the current free-gift campaign.
  - Past sources (which monthly bundle or event) come from the directory scan. It reads 40 pages of 100 accounts per run, working through "", every character, then every two-character pair, and skips to the next search once it runs out of collectors.
  - Accounts that own every paint (7TV team) are ignored as a source.
  - A paint nobody has been seen owning shows as "source not known yet".
- **No overall leaderboard:** 7TV has about 2.9 million accounts and no complete public list. Search reliably surfaces active subscribers, but not people who used to subscribe and kept their paints, so a "top collectors" ranking can't be made accurate.
- **Owned / wearing counts** (estimates, in the "Estimated popularity" part of paint popups and the "Most worn" and "Most owned" sorts):
  - These come from PotatBotat (potat.app) via 7database.com's public stats API, which covers about 70,000 users.
  - The checker fetches it once per run into `data/community.json`, so visitors never call 7database directly.
  - It only covers items someone it tracks is wearing, about 380 of 1,066 paints. For the rest, the site falls back to Paintwatch's own scan and says so.
  - The API is open to any site and its terms don't forbid this use, but if Paintwatch gets popular, it's polite to let 7database and PotatBotat know.
- **Paint owners from Paintwatch's own scan** ("Some owners" lists, and counts for paints nobody is wearing): these count only the accounts the scan has seen. The full index lives in the GitHub Actions cache (`cache/`, not committed). If GitHub evicts the cache, the index rebuilds itself over the next day of runs.
- Unlock times are a window: the item appeared between two checks. 7TV doesn't record when an item was unlocked. Paint and badge *switches* use 7TV's exact timestamps.
- **Firsts:**
  - The checker remembers every paint it has seen and announces new ones.
  - A paint that no tracked streamer owned at the previous check gets a "first" when 1 to 3 of them have it at the next check.
  - When more than 3 get it in the same check, it's reported as a release, since that's usually a bundle.
  - For collab paints, it also looks up the account the paint is named after (for example, the "Luzif6r" paint on the Luzif6r account), even if that streamer isn't tracked. That account is reported as having its own paint, not as the first owner, because Paintwatch can't know when they got it.
  - Firsts only count from when the checker started running.
- "Upcoming" paints were added to 7TV in the last 60 days and no tracked streamer owns them yet. Most are the next monthly bundle or an event reward, but 7TV doesn't publish release dates, so treat the list as a strong hint, not a schedule.
- Profile views are counted by abacus.jasoncameron.dev, a free public counter, and only on the published site. A view counts once per visitor session. Anyone could inflate the numbers on purpose, so they're for fun, not proof.
- Names are looked up with 7TV's own user search, so Kick- and Discord-main accounts work. ivr.fi, a public Twitch lookup, is the fallback when that search is down.
- GitHub disables scheduled workflows after 60 days with no repository activity. The checker's own commits count as activity, but a quiet period with no changes at all can still trigger it. Re-enable it under **Actions** if that happens.
