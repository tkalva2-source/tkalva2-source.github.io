// Paintwatch 24/7 checker. Run by GitHub Actions on a schedule (or locally: `node tracker/check.mjs`).
// Reads tracker/users.txt, compares every user's 7TV inventory with the last run, posts unlocks to
// Discord (DISCORD_WEBHOOK env), and writes data/events.json + data/leaderboard.json for the site.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const DATA = new URL("data/", ROOT);
const GQL = "https://7tv.io/v4/gql";
const IVR = "https://api.ivr.fi/v2/twitch/user?login=";
const HOOK = process.env.DISCORD_WEBHOOK || "";
const DEBUG = !!process.env.PAINTWATCH_DEBUG;
const MAX_EVENTS = 1000;
const STALE_MS = 6 * 3600e3; // rewrite leaderboard at least this often so "updated" stays truthful
const FIRST_DAYS = 90; // paints newer than this are watched for their first owner
const NAME_PER_RUN = 8, NAME_RECHECK_MS = 6 * 3600e3;
const MAX_FIRSTS = 3; // more people than this getting a paint in the same check is a release, not a "first"
// Directory scan: page through 7TV's user search (100 accounts with inventories per request), a few pages per run,
// to learn where paints come from and estimate owners. Each query stops at 100 pages, so it rotates through
// "", every single character, then every two-character pair. Subscribers come first in results, so a query is
// dropped once SCAN_EMPTY_PAGES pages in a row hold nobody with a paint.
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const SCAN_QUERIES = ["", ...CHARS, ...[...CHARS].flatMap(a => [...CHARS].map(b => a + b))];
const SCAN_EMPTY_PAGES = 2;
const SCAN_PAGES_PER_RUN = +process.env.PAINTWATCH_SCAN_PAGES || 40; // raise locally to seed the index faster
// Every scanned account's paints live in cache/index.json (too big for git; GitHub Actions caches it between runs).
// Only per-paint summaries are published, and at most this often since the counts move every run.
const CACHE = new URL("cache/", ROOT);
const OWNER_LIST = 25, PAINTS_STALE_MS = 3 * 3600e3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (name, d) => { try { return JSON.parse(await readFile(new URL(name, DATA), "utf8")); } catch { return d; } };
const writeJson = (name, v) => writeFile(new URL(name, DATA), JSON.stringify(v, null, 1) + "\n");

async function gql(query, variables = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(GQL, { method: "POST", headers: { "content-type": "application/json", "user-agent": "paintwatch-checker" }, body: JSON.stringify({ query, variables }) });
      if (!r.ok) throw new Error("7TV " + r.status);
      const j = await r.json();
      if (!j.data && j.errors) throw new Error(j.errors[0].message);
      return j.data;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(3000 * i);
    }
  }
}

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulidTime(id) {
  let t = 0;
  for (const c of String(id).slice(0, 10).toUpperCase()) { const v = B32.indexOf(c); if (v < 0) return 0; t = t * 32 + v; }
  return t;
}

const FROM = `from{__typename ... on EntitlementNodeSubscriptionBenefit{subscriptionBenefit{name}} ... on EntitlementNodeRole{role{name}} ... on EntitlementNodeSpecialEvent{specialEvent{name}}}`;
const USER_Q = `query($id:String!){users{userByConnection(platform:TWITCH,platformId:$id){id
 mainConnection{platformDisplayName platformUsername platformAvatarUrl} style{activePaintId activeBadgeId}
 inventory{paints{accessible to{... on EntitlementNodePaint{paintId}} ${FROM}} badges{accessible to{... on EntitlementNodeBadge{badgeId}} ${FROM}}}
}}}`;

function source(from) {
  switch (from?.__typename) {
    case "EntitlementNodeSubscriptionBenefit": return from.subscriptionBenefit?.name || "Subscription";
    case "EntitlementNodeSpecialEvent": return from.specialEvent?.name || "Event";
    case "EntitlementNodeProduct": case "EntitlementNodeShopItem": return "Store";
    case "EntitlementNodeRole": return from.role?.name || "Role";
    case "EntitlementNodeUser": return "Granted directly";
    case "EntitlementNodeSubscription": return "Active 7TV subscription";
    default: return null;
  }
}

export function inventory(edges, key) {
  const m = new Map();
  for (const e of edges) {
    const id = e.to?.[key];
    if (!id || e.accessible === false) continue; // inaccessible entitlements aren't usable, so don't count them
    if (!m.has(id) || !m.get(id)) m.set(id, source(e.from));
  }
  return m;
}

// Compares the saved snapshot with a fresh one; returns gain / loss / equip events.
export function diff(prev, cur, base) {
  const out = [];
  for (const kind of ["paints", "badges"]) {
    const before = new Set(prev[kind]);
    for (const [id, src] of cur[kind]) if (!before.has(id)) out.push({ ...base, type: "gain", kind, id, src });
    for (const id of prev[kind]) if (!cur[kind].has(id)) out.push({ ...base, type: "loss", kind, id });
  }
  if (prev.paint !== cur.paint) out.push({ ...base, type: "equip", kind: "paints", id: cur.paint });
  if (prev.badge !== cur.badge) out.push({ ...base, type: "equip", kind: "badges", id: cur.badge });
  return out;
}

async function loadCatalog() {
  const d = await gql(`{paints{paints{id name data{layers{ty{... on PaintLayerTypeSingleColor{color{hex}} ... on PaintLayerTypeLinearGradient{stops{color{hex}}} ... on PaintLayerTypeRadialGradient{stops{color{hex}}}}}}}} badges{badges{id name images{url scale}}}}`);
  const paints = new Map(d.paints.paints.map(p => {
    const t = p.data?.layers?.[0]?.ty;
    return [p.id, { name: p.name, color: t?.color?.hex || t?.stops?.[0]?.color?.hex || null }];
  }));
  const badges = new Map(d.badges.badges.map(b => [b.id, { name: b.name, img: b.images?.find(i => i.scale === 3 && /\.webp$/.test(i.url) && !/_static/.test(i.url))?.url || b.images?.[0]?.url }]));
  return { paints, badges };
}

async function twitchId(entry, cache) {
  if (/^\d+$/.test(entry)) return entry;
  const login = entry.toLowerCase().replace(/^@/, "");
  if (cache[login]) return cache[login];
  const r = await fetch(IVR + encodeURIComponent(login));
  if (!r.ok) throw new Error("ivr " + r.status);
  const id = (await r.json())?.[0]?.id;
  if (!id) throw new Error(`no Twitch account "${login}"`);
  return (cache[login] = id);
}

function describe(e, cat) {
  const it = cat[e.kind].get(e.id), thing = e.kind === "paints" ? "paint" : "badge", name = it?.name || (e.id ? "an unknown item" : "nothing");
  if (e.type === "new-paint") return `New paint on 7TV: ${name}`;
  if (e.type === "first") return e.how === "name" ? `${e.who} has their own paint: ${name}`
    : e.count > MAX_FIRSTS ? `The ${name} paint is out: ${e.count} tracked streamers got it` : `${e.who} ${e.count > 1 ? "are" : "is"} the first to get the ${name} paint`;
  return e.type === "gain" ? `${e.who} unlocked the ${name} ${thing}` : e.type === "loss" ? `${e.who} lost the ${name} ${thing}` : `${e.who} switched ${thing} to ${name}`;
}

// Records who was first seen owning a watched paint. Users found in the same run share the "first".
export function claimFirsts(candidates, firsts, user, paintIds, run) {
  const claimed = [];
  for (const id of paintIds) {
    if (!candidates.has(id)) continue;
    const f = firsts[id];
    if (!f) { firsts[id] = { at: run.at, since: run.since, how: "tracked", users: [user] }; claimed.push(id); }
    else if (f.at === run.at && f.how === "tracked" && !f.users.some(u => u.uid === user.uid)) f.users.push(user);
  }
  return claimed;
}

// The account name a paint would be named after ("Luzif6r" → "luzif6r"), or null if the name can't be one.
export function nameKey(name) {
  const k = String(name || "").toLowerCase().replace(/\s+/g, "");
  return /^[a-z0-9_]{3,25}$/.test(k) ? k : null;
}

// Collab paints are often named after the streamer, who may not be tracked: look for that account and check it owns the paint.
const SEARCH_Q = `query($q:String!){users{search(query:$q,perPage:5){items{id mainConnection{platformUsername platformDisplayName platformAvatarUrl} connections{platformUsername}}}}}`;
const OWNS_Q = `query($id:Id!){users{user(id:$id){inventory{paints{accessible to{... on EntitlementNodePaint{paintId}}}}}}}`;
async function nameOwner(paintId, paintName) {
  const key = nameKey(paintName);
  if (!key) return null;
  const items = (await gql(SEARCH_Q, { q: key })).users.search.items || [];
  const u = items.find(u => [u.mainConnection, ...(u.connections || [])].some(c => c?.platformUsername?.toLowerCase() === key));
  if (!u) return null;
  await sleep(600);
  const inv = (await gql(OWNS_Q, { id: u.id })).users.user?.inventory.paints || [];
  if (!inv.some(e => e.to?.paintId === paintId && e.accessible !== false)) return null;
  const m = u.mainConnection || {};
  return { uid: u.id, name: m.platformDisplayName || key, login: m.platformUsername || key, avatar: m.platformAvatarUrl || null };
}

const FROM_NAMES = `from{__typename ... on EntitlementNodeSubscriptionBenefit{subscriptionBenefit{name}} ... on EntitlementNodeSpecialEvent{specialEvent{name}} ... on EntitlementNodeRole{role{name}}}`;
const SCAN_FIELDS = `id mainConnection{platformUsername platformDisplayName} style{activePaintId}
 inventory{paints{accessible to{... on EntitlementNodePaint{paintId}} ${FROM_NAMES}} badges{accessible to{... on EntitlementNodeBadge{badgeId}} ${FROM_NAMES}}}`;
const SCAN_Q = `query($q:String!,$p:Int){users{search(query:$q,page:$p,perPage:100){pageCount items{${SCAN_FIELDS}}}}}`;

// Where an item came from, as "kind|name": how the site explains how to get it.
export function srcLabel(f) {
  switch (f?.__typename) {
    case "EntitlementNodeSubscriptionBenefit": { const n = f.subscriptionBenefit?.name || ""; return /bundle/i.test(n) ? `bundle|${n}` : `subscriber|${n}`; }
    case "EntitlementNodeSpecialEvent": return `event|${f.specialEvent?.name || ""}`;
    case "EntitlementNodeSubscription": return "subscription|";
    case "EntitlementNodeProduct": case "EntitlementNodeShopItem": return "shop|";
    case "EntitlementNodeUser": return "granted|";
    case "EntitlementNodeRole": return `role|${f.role?.name || ""}`;
    default: return null;
  }
}

// One search result → an index row (distinct, accessible items only). `ps` = paint ids, `src` = [itemId, source] pairs.
export function scanRow(u, catalogSize) {
  const paints = new Set(), badges = new Set(), src = new Set();
  for (const [edges, k, set] of [[u.inventory?.paints || [], "paintId", paints], [u.inventory?.badges || [], "badgeId", badges]])
    for (const e of edges) {
      const id = e.to?.[k];
      if (!id || e.accessible === false) continue;
      set.add(id);
      const l = srcLabel(e.from);
      if (l) src.add(id + " " + l);
    }
  const m = u.mainConnection || {}, everything = paints.size >= catalogSize;
  return {
    id: u.id, name: m.platformDisplayName || m.platformUsername || "unknown", paint: u.style?.activePaintId || null,
    paints: paints.size, badges: badges.size,
    // 7TV team accounts get every cosmetic automatically, so they aren't counted as owners and say nothing about how items are obtained.
    everything, ps: [...paints], src: everything ? [] : [...src].map(s => [s.slice(0, s.indexOf(" ")), s.slice(s.indexOf(" ") + 1)]),
  };
}

// The ownership index: account id → row, with paint ids stored as numbers into an append-only list to keep it small.
// `sources` collects every way each item has been seen obtained.
async function loadIndex() { try { return JSON.parse(await readFile(new URL("index.json", CACHE), "utf8")); } catch { return { paintIds: [], users: {}, sources: {} }; } }
async function saveIndex(idx) { await mkdir(CACHE, { recursive: true }); await writeFile(new URL("index.json", CACHE), JSON.stringify(idx)); }
export function indexRow(idx, row) {
  idx.sources ||= {};
  for (const [id, l] of row.src || []) (idx.sources[id] ||= {})[l] = 1;
  if (row.paints + row.badges === 0) { delete idx.users[row.id]; return; }
  const pos = idx._pos ||= new Map(idx.paintIds.map((id, i) => [id, i]));
  const ps = row.ps.map(id => { if (!pos.has(id)) { pos.set(id, idx.paintIds.length); idx.paintIds.push(id); } return pos.get(id); });
  const { ps: _, src: __, ...rest } = row;
  idx.users[row.id] = { ...rest, ps };
}

async function scanGlobal(state, idx, cat) {
  const g = state.global ||= { q: 0, page: 1, checked: 0, cycles: 0, empty: 0 };
  let pages = 0;
  while (pages < SCAN_PAGES_PER_RUN) {
    let d;
    try { d = (await gql(SCAN_Q, { q: SCAN_QUERIES[g.q % SCAN_QUERIES.length], p: g.page })).users.search; }
    catch (e) { console.error("scan failed:", e.message); break; }
    pages++;
    let withPaints = 0;
    for (const u of d.items || []) { const r = scanRow(u, cat.paints.size); indexRow(idx, r); g.checked++; if (r.paints) withPaints++; }
    g.empty = withPaints ? 0 : (g.empty || 0) + 1;
    if (!d.items?.length || g.page >= (d.pageCount || 1) || g.empty >= SCAN_EMPTY_PAGES) {
      g.page = 1; g.empty = 0; g.q = (g.q + 1) % SCAN_QUERIES.length; if (g.q === 0) g.cycles++;
    } else g.page++;
    await sleep(1500);
  }
  return pages;
}

// What's on sale or on offer right now: this month's subscriber paints, the shop, and any free-gift campaign.
const STORE_Q = `{store{monthlyPaints{id}}
 shop{shopProducts{paints{name items{id type} defaultCurrency currencyPrices public discount} badges{name items{id type} defaultCurrency currencyPrices public discount} bundles{name items{id type} defaultCurrency currencyPrices public discount}}}
 freeGifts{activeCampaign{name activePeriod{start end} recipientCount paints{id} badges{id}}}}`;
export function storeTable(d) {
  const sp = d.shop?.shopProducts || {};
  const shop = [...(sp.paints || []), ...(sp.badges || []), ...(sp.bundles || [])].filter(p => p.public !== false).map(p => ({
    name: p.name, items: (p.items || []).map(i => i.id), currency: p.defaultCurrency, price: p.currencyPrices?.[p.defaultCurrency] ?? null, bundle: (p.items || []).length > 1,
  }));
  const c = d.freeGifts?.activeCampaign;
  return {
    monthly: (d.store?.monthlyPaints || []).map(p => p.id), shop,
    gift: c ? { name: c.name, start: c.activePeriod?.start, end: c.activePeriod?.end, recipients: c.recipientCount, items: [...(c.paints || []), ...(c.badges || [])].map(i => i.id) } : null,
  };
}

// Per paint: how many known accounts own it, how many wear it, and the biggest collections among its owners.
export function paintSummaries(idx, isAll = () => false) {
  const owners = new Map(), wearing = new Map();
  for (const u of Object.values(idx.users)) {
    if (isAll(u)) continue; // accounts that own every paint would make every count look owned
    for (const i of u.ps) { const id = idx.paintIds[i]; (owners.get(id) || owners.set(id, []).get(id)).push(u); }
    if (u.paint) wearing.set(u.paint, (wearing.get(u.paint) || 0) + 1);
  }
  const out = {};
  for (const [id, list] of owners) {
    list.sort((a, b) => (b.paints + b.badges) - (a.paints + a.badges));
    out[id] = { owners: list.length, wearing: wearing.get(id) || 0, top: list.slice(0, OWNER_LIST).map(u => [u.id, u.name, u.paint === id ? 1 : 0]) };
  }
  return out;
}

// Community owner/wearer counts from PotatBotat, published by 7database.com. Fetched once per run (not per visitor)
// and only for paints/badges someone is wearing, so the site falls back to its own scan for the rest.
const COMMUNITY = "https://7database.com/api/api.php?stats&type=";
export function communityTable(d) {
  return { users: d.userCount, updated: d.updated, items: Object.fromEntries((d.entries || []).map(e => [e.id, [e.owned_count, e.active_count]])) };
}
async function fetchCommunity() {
  const get = async type => { const r = await fetch(COMMUNITY + type, { headers: { "user-agent": "paintwatch-checker" }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(type + " " + r.status); return communityTable(await r.json()); };
  return { source: "PotatBotat via 7database.com", paints: await get("paints"), badges: await get("badges") };
}

async function postDiscord(evs, cat) {
  // Equips are too noisy for a channel; a "first" replaces the plain unlock for the same person and paint.
  const firsts = new Set(evs.filter(e => e.type === "first").map(e => e.uid + e.id));
  const wanted = evs.filter(e => e.type === "first" || e.type === "new-paint" || (e.type === "gain" && !firsts.has(e.uid + e.id)));
  const site = process.env.SITE_URL?.replace(/\/$/, "");
  for (let i = 0; i < wanted.length; i += 10) {
    const embeds = wanted.slice(i, i + 10).map(e => {
      const it = cat[e.kind].get(e.id);
      const description = e.type === "new-paint" ? "Nobody has it yet. Paintwatch will report who gets it first."
        : e.type === "first" ? (e.how === "name" ? "Found on the account the paint is named after." : e.count > MAX_FIRSTS ? "Many got it at once, so it was likely released as a bundle or event." : "First of the tracked streamers seen with it.")
        : e.src ? `From **${e.src}**` : undefined;
      return {
        title: describe(e, cat), description,
        color: parseInt((it?.color || "#a493ff").slice(1, 7), 16), timestamp: new Date(e.at).toISOString(),
        thumbnail: e.kind === "badges" && it?.img ? { url: it.img } : e.avatar ? { url: e.avatar } : undefined,
        url: site ? (e.type === "new-paint" ? `${site}/?v=catalog` : `${site}/?u=${encodeURIComponent(e.login || e.uid)}`) : undefined,
      };
    });
    const body = JSON.stringify({ username: "Paintwatch", embeds });
    if (DEBUG) console.log("discord payload:", body);
    if (!HOOK) continue;
    const r = await fetch(HOOK, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!r.ok) console.error("Discord webhook failed:", r.status, await r.text());
    await sleep(1000);
  }
}

async function main() {
  await mkdir(DATA, { recursive: true });
  const list = (await readFile(new URL("tracker/users.txt", ROOT), "utf8")).split(/\r?\n/).map(l => l.replace(/#.*/, "").trim()).filter(Boolean);
  const state = await readJson("state.json", { logins: {}, users: {} });
  const eventsFile = await readJson("events.json", null), events = eventsFile || [];
  const oldBoard = await readJson("leaderboard.json", null);
  const oldOwners = await readJson("owners.json", null);
  // Each unlock happened after the previous run started, so events carry that as the start of their time window.
  const lastRun = await readJson("lastrun.json", null), runStart = Date.now();
  const cat = await loadCatalog();
  const latest30 = [...cat.paints.keys()].sort((a, b) => ulidTime(b) - ulidTime(a)).slice(0, 30);

  // New paints since the last run, and which recent paints are still waiting for their first owner.
  const firstRun = !state.paintsSeen;
  state.paintsSeen ||= {}; state.firsts ||= {}; state.nameChecked ||= {};
  const run = { at: runStart, since: lastRun?.at || null };
  const recent = id => runStart - ulidTime(id) < FIRST_DAYS * 864e5;
  const catalogEvents = [];
  for (const id of cat.paints.keys()) if (!state.paintsSeen[id]) {
    state.paintsSeen[id] = runStart;
    if (!firstRun) catalogEvents.push({ type: "new-paint", kind: "paints", id, at: runStart, since: run.since });
  }
  // Only paints nobody tracked owned last run can have a known "first"; on the first run nothing qualifies yet.
  const candidates = new Set([...(state.unclaimed || []), ...catalogEvents.map(e => e.id)]);

  const fresh = [], board = [], seen = new Set(), failed = [];
  for (const entry of list) {
    try {
      const tid = await twitchId(entry, state.logins);
      const d = (await gql(USER_Q, { id: tid })).users.userByConnection;
      if (!d) { failed.push(`${entry} (not on 7TV)`); continue; }
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const cur = { paints: inventory(d.inventory.paints, "paintId"), badges: inventory(d.inventory.badges, "badgeId"), paint: d.style?.activePaintId || null, badge: d.style?.activeBadgeId || null };
      const name = d.mainConnection?.platformDisplayName || entry, login = d.mainConnection?.platformUsername || entry.toLowerCase();
      const avatar = d.mainConnection?.platformAvatarUrl || null;
      const prev = state.users[d.id];
      if (prev) fresh.push(...diff(prev, cur, { at: Date.now(), since: lastRun?.at || null, who: name, login, uid: d.id, avatar }));
      state.users[d.id] = { name, login, paints: [...cur.paints.keys()], badges: [...cur.badges.keys()], paint: cur.paint, badge: cur.badge };
      claimFirsts(candidates, state.firsts, { uid: d.id, name, login, avatar }, cur.paints.keys(), run);
      const newest = [...cur.paints.keys()].sort((a, b) => ulidTime(b) - ulidTime(a))[0] || null;
      board.push({ id: d.id, name, login, avatar, paint: cur.paint, badge: cur.badge, paints: cur.paints.size, badges: cur.badges.size,
        latest: latest30.filter(id => cur.paints.has(id)).length, newestPaint: newest });
    } catch (e) { failed.push(`${entry} (${e.message})`); }
    await sleep(1200); // stay well under 7TV's rate limits
  }
  // Drop users no longer in users.txt so they don't fire a flood of events if re-added much later.
  for (const id of Object.keys(state.users)) if (!seen.has(id) && !failed.length) delete state.users[id];

  // Unclaimed paints named like an account: check whether that account owns it (a few per run, each at most every 6h).
  let nameChecks = 0;
  for (const id of candidates) {
    const p = cat.paints.get(id);
    if (state.firsts[id] || !p || !nameKey(p.name) || nameChecks >= NAME_PER_RUN || runStart - (state.nameChecked[id] || 0) < NAME_RECHECK_MS) continue;
    nameChecks++; state.nameChecked[id] = runStart;
    try { const u = await nameOwner(id, p.name); if (u) state.firsts[id] = { at: runStart, since: null, how: "name", users: [u] }; } catch {}
    await sleep(800);
  }
  for (const [id, f] of Object.entries(state.firsts)) if (f.at === runStart) {
    const u = f.users[0];
    const many = f.users.length > MAX_FIRSTS;
    catalogEvents.push({ type: "first", kind: "paints", id, at: runStart, since: f.since, how: f.how, count: f.users.length,
      who: many ? `${f.users.length} tracked streamers` : f.users.map(x => x.name).join(" and "), uid: u.uid, login: u.login, avatar: many ? null : u.avatar });
  }
  fresh.push(...catalogEvents);

  board.sort((a, b) => (b.paints + b.badges) - (a.paints + a.badges) || b.paints - a.paints);
  const rows = JSON.stringify(board);
  const boardChanged = !oldBoard || JSON.stringify(oldBoard.users) !== rows || Date.now() - Date.parse(oldBoard.updatedAt) > STALE_MS;
  if (boardChanged) await writeJson("leaderboard.json", { updatedAt: new Date().toISOString(), catalog: { paints: cat.paints.size, badges: cat.badges.size }, tracked: board.length, users: board });
  if (fresh.length || !eventsFile) await writeJson("events.json", [...fresh, ...events].slice(0, MAX_EVENTS));
  // How many tracked users own each paint; the site uses it for rarity and to spot paints nobody has yet.
  const owners = { users: Object.keys(state.users).length, paints: {} };
  for (const u of Object.values(state.users)) for (const id of u.paints) owners.paints[id] = (owners.paints[id] || 0) + 1;
  if (JSON.stringify(owners) !== JSON.stringify(oldOwners)) await writeJson("owners.json", owners);
  // Recent paints with no known creator stay on the list for the name check, whether or not anyone owns them yet.
  state.unclaimed = [...cat.paints.keys()].filter(id => recent(id) && !state.firsts[id]);
  for (const id of Object.keys(state.nameChecked)) if (!state.unclaimed.includes(id)) delete state.nameChecked[id];
  // Paint ownership + sources from the directory scan. Tracked streamers are folded in with their fresh numbers.
  const idx = await loadIndex();
  // A fresh cache (first run on GitHub, or after the cache was evicted) starts from the published sources, so they never shrink.
  if (!Object.keys(idx.sources || {}).length)
    idx.sources = Object.fromEntries(Object.entries((await readJson("sources.json", { items: {} })).items).map(([id, ls]) => [id, Object.fromEntries(ls.map(l => [l, 1]))]));
  const scanned = await scanGlobal(state, idx, cat);
  for (const r of board) indexRow(idx, { id: r.id, name: r.name, paint: r.paint, paints: r.paints, badges: r.badges, everything: r.paints >= cat.paints.size, ps: state.users[r.id].paints });
  delete idx._pos;
  await saveIndex(idx);
  // Decided here, not at scan time, so older index entries follow the current rule and catalog size.
  const isAll = r => r.paints >= cat.paints.size;
  const all = Object.values(idx.users);
  const oldPaints = await readJson("paints.json", null);
  if (!oldPaints || Date.now() - Date.parse(oldPaints.updatedAt) > PAINTS_STALE_MS) await writeJson("paints.json", { updatedAt: new Date().toISOString(), accounts: all.filter(r => !isAll(r)).length, excluded: all.filter(isAll).length, paints: paintSummaries(idx, isAll) });
  const sources = { items: Object.fromEntries(Object.entries(idx.sources || {}).map(([id, ls]) => [id, Object.keys(ls).sort()])) };
  if (JSON.stringify(sources) !== JSON.stringify(await readJson("sources.json", null))) await writeJson("sources.json", sources);
  try {
    const store = storeTable(await gql(STORE_Q));
    if (JSON.stringify(store) !== JSON.stringify(await readJson("store.json", null))) await writeJson("store.json", store);
  } catch (e) { console.error("store unavailable:", e.message); }

  try {
    const community = await fetchCommunity(), old = await readJson("community.json", null);
    if (!old || old.paints.updated !== community.paints.updated || old.badges.updated !== community.badges.updated) await writeJson("community.json", community);
  } catch (e) { console.error("community stats unavailable:", e.message); }

  const firstsOut = Object.entries(state.firsts).map(([id, f]) => ({ id, ...f })).sort((a, b) => b.at - a.at).slice(0, 200);
  if (JSON.stringify(firstsOut) !== JSON.stringify(await readJson("firsts.json", null))) await writeJson("firsts.json", firstsOut);
  await writeJson("state.json", state);
  await writeJson("lastrun.json", { at: runStart });
  await postDiscord(fresh, cat);

  const n = t => fresh.filter(e => e.type === t).length;
  console.log(`scanned ${scanned} directory pages (${state.global.checked} results so far, ${Object.keys(idx.users).length} accounts with cosmetics indexed, ${Object.keys(idx.sources || {}).length} item sources known, query ${state.global.q + 1}/${SCAN_QUERIES.length} page ${state.global.page})`);
  console.log(`checked ${board.length} users · ${n("gain")} unlocks · ${n("new-paint")} new paints · ${n("first")} firsts · ${state.unclaimed.length} paints awaiting a first owner${failed.length ? ` · failed: ${failed.join(", ")}` : ""}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) main().catch(e => { console.error(e); process.exit(1); });
