// Run with: node --test tracker/check.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { diff, inventory, ulidTime, claimFirsts, nameKey, scanRow, indexRow, paintSummaries, communityTable, srcLabel, storeTable } from "./check.mjs";

test("communityTable keeps owned and wearing counts by id", () => {
  const t = communityTable({ userCount: 70146, updated: "2026-10-31", entries: [{ id: "P1", owned_count: 30672, active_count: 1317 }] });
  assert.deepEqual(t, { users: 70146, updated: "2026-10-31", items: { P1: [30672, 1317] } });
});

test("scan rows count distinct accessible items and record where each came from", () => {
  const u = { id: "U1", mainConnection: { platformDisplayName: "Ann" }, style: { activePaintId: "P1" }, inventory: {
    paints: [{ to: { paintId: "P1" }, from: { __typename: "EntitlementNodeSubscriptionBenefit", subscriptionBenefit: { name: "May 2022 Paint Bundle" } } },
      { to: { paintId: "P1" }, from: { __typename: "EntitlementNodeSpecialEvent", specialEvent: { name: "XDX" } } },
      { accessible: false, to: { paintId: "P2" }, from: { __typename: "EntitlementNodeUser" } }],
    badges: [{ to: { badgeId: "B1" }, from: { __typename: "EntitlementNodeShopItem" } }] } };
  const r = scanRow(u, 1000);
  assert.deepEqual([r.paints, r.badges, r.everything, r.ps], [1, 1, false, ["P1"]]);
  assert.deepEqual(r.src.sort(), [["B1", "shop|"], ["P1", "bundle|May 2022 Paint Bundle"], ["P1", "event|XDX"]]);
  assert.equal(scanRow(u, 1).everything, true); // owns the whole (1-paint) catalog
  assert.deepEqual(scanRow(u, 1).src, []); // team accounts with everything don't count as a source
  const idx = { paintIds: [], users: {} };
  indexRow(idx, r);
  assert.deepEqual(Object.keys(idx.sources.P1).sort(), ["bundle|May 2022 Paint Bundle", "event|XDX"]);
  assert.equal(idx.users.U1.src, undefined); // sources aren't stored per user
});

test("srcLabel and storeTable describe how items are obtained", () => {
  assert.equal(srcLabel({ __typename: "EntitlementNodeSubscriptionBenefit", subscriptionBenefit: { name: "3 Month Badge" } }), "subscriber|3 Month Badge");
  assert.equal(srcLabel({ __typename: "EntitlementNodeUser" }), "granted|");
  const s = storeTable({ store: { monthlyPaints: [{ id: "M1" }] },
    shop: { shopProducts: { paints: [{ name: "Uranium", items: [{ id: "P9" }], defaultCurrency: "eur", currencyPrices: { eur: 299 }, public: true }], badges: [], bundles: [] } },
    freeGifts: { activeCampaign: { name: "Gift 3 Subs", activePeriod: { start: "a", end: "b" }, recipientCount: 3, paints: [{ id: "P5" }], badges: [{ id: "B5" }] } } });
  assert.deepEqual(s, { monthly: ["M1"], shop: [{ name: "Uranium", items: ["P9"], currency: "eur", price: 299, bundle: false }],
    gift: { name: "Gift 3 Subs", start: "a", end: "b", recipients: 3, items: ["P5", "B5"] } });
});

test("index + summaries count owners and wearers per paint", () => {
  const idx = { paintIds: [], users: {} };
  indexRow(idx, { id: "a", name: "A", paints: 2, badges: 0, paint: "P1", ps: ["P1", "P2"] });
  indexRow(idx, { id: "b", name: "B", paints: 1, badges: 0, paint: null, ps: ["P1"] });
  indexRow(idx, { id: "c", name: "C", paints: 0, badges: 0, ps: [] }); // nothing owned: not indexed
  const s = paintSummaries(idx);
  assert.deepEqual([s.P1.owners, s.P1.wearing, s.P2.owners, Object.keys(idx.users).length], [2, 1, 1, 2]);
  assert.deepEqual(s.P1.top.map(t => t[0]), ["a", "b"]); // biggest collection first
  assert.equal(paintSummaries(idx, u => u.id === "a").P2, undefined); // owners of everything aren't counted
});

test("claimFirsts credits only watched paints, and shares a first within one run", () => {
  const firsts = {}, watched = new Set(["P1"]);
  const run1 = { at: 100, since: 50 };
  assert.deepEqual(claimFirsts(watched, firsts, { uid: "a" }, ["P1", "P2"], run1), ["P1"]);
  claimFirsts(watched, firsts, { uid: "b" }, ["P1"], run1); // same run: co-first
  claimFirsts(watched, firsts, { uid: "c" }, ["P1"], { at: 200, since: 100 }); // later run: not first
  assert.deepEqual(firsts.P1.users.map(u => u.uid), ["a", "b"]);
  assert.equal(firsts.P2, undefined);
});

test("nameKey matches account-style paint names only", () => {
  assert.equal(nameKey("Luzif6r"), "luzif6r");
  assert.equal(nameKey("Decker Down"), "deckerdown");
  assert.equal(nameKey("4th of July!"), null);
  assert.equal(nameKey("ab"), null);
});

test("diff reports gains, losses and equip changes", () => {
  const prev = { paints: ["A", "B"], badges: ["X"], paint: "A", badge: null };
  const cur = { paints: new Map([["B", null], ["C", "May Bundle"]]), badges: new Map([["X", null]]), paint: "C", badge: null };
  const ev = diff(prev, cur, { who: "u" }).map(e => `${e.type}:${e.id}`);
  assert.deepEqual(ev.sort(), ["equip:C", "gain:C", "loss:A"]);
});

test("inventory skips inaccessible entries and prefers a named source", () => {
  const m = inventory([
    { accessible: true, to: { paintId: "A" }, from: { __typename: "EntitlementNodeGlobalDefaultEntitlementGroup" } },
    { accessible: true, to: { paintId: "A" }, from: { __typename: "EntitlementNodeSubscriptionBenefit", subscriptionBenefit: { name: "May" } } },
    { accessible: false, to: { paintId: "B" }, from: {} },
  ], "paintId");
  assert.deepEqual([...m], [["A", "May"]]);
});

test("ulidTime decodes a ULID timestamp", () => {
  assert.equal(new Date(ulidTime("01M66TY810KZS3FBHS210G52DW")).toISOString(), "2026-10-30T16:40:26.912Z");
});
