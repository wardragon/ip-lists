const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { openDatabase, createStore } = require("./db");
const { createLists } = require("./lists");
const { DEFAULT_BLACKLIST_TTL_MS, DAY_MS, toIso } = require("./time");
const { migrate } = require("./migrate");
const Database = require("better-sqlite3");

function setup(start = "2026-01-01T00:00:00.000Z") {
  let now = new Date(start);
  const store = createStore(openDatabase(":memory:"));
  const lists = createLists(store, { now: () => new Date(now) });
  return {
    store,
    lists,
    setNow(value) {
      now = new Date(value);
    },
    addMs(ms) {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

describe("blacklist expiration", () => {
  it("defaults expiration to insertion date + 5 days", () => {
    const { lists } = setup("2026-01-01T00:00:00.000Z");
    const { entry } = lists.addEntry("blacklist", "1.2.3.4");
    assert.equal(entry.list, "blacklist");
    assert.equal(entry.expiresAt, "2026-01-06T00:00:00.000Z");
    assert.equal(new Date(entry.expiresAt).getTime() - new Date(entry.createdAt).getTime(), DEFAULT_BLACKLIST_TTL_MS);
  });

  it("accepts a custom expiration date", () => {
    const { lists } = setup();
    const { entry } = lists.addEntry("blacklist", "1.2.3.4", { expiresAt: "2026-02-01T12:00:00.000Z" });
    assert.equal(entry.expiresAt, "2026-02-01T12:00:00.000Z");
  });

  it("creates a permanent blacklist entry when expiresAt is null", () => {
    const { lists } = setup();
    const { entry } = lists.addEntry("blacklist", "1.2.3.4", { expiresAt: null });
    assert.equal(entry.expiresAt, null);
    assert.equal(entry.list, "blacklist");
  });

  it("creates a permanent blacklist entry when permanent is true", () => {
    const { lists } = setup();
    const { entry } = lists.addEntry("blacklist", "1.2.3.4", { permanent: true });
    assert.equal(entry.expiresAt, null);
  });

  it("updates an expiration date and can switch to no expiration", () => {
    const { lists } = setup();
    const created = lists.addEntry("blacklist", "8.8.8.8").entry;
    const updated = lists.updateExpiration(created.id, { expiresAt: "2026-03-01T00:00:00.000Z" }).entry;
    assert.equal(updated.expiresAt, "2026-03-01T00:00:00.000Z");
    const permanent = lists.updateExpiration(created.id, { permanent: true }).entry;
    assert.equal(permanent.expiresAt, null);
    assert.equal(permanent.list, "blacklist");
  });
});

describe("automatic blacklist to graylist", () => {
  it("moves an expired IP to graylist and records the insertion", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    ctx.lists.addEntry("blacklist", "1.2.3.4");
    ctx.setNow("2026-01-06T00:00:00.000Z");
    const moved = ctx.lists.processExpirations();
    assert.equal(moved.length, 1);
    assert.equal(moved[0].transition, "graylist_insert");
    assert.equal(moved[0].entry.list, "graylist");
    assert.equal(moved[0].entry.cidr, "1.2.3.4/32");
    assert.equal(moved[0].entry.reason, "blacklist_expired");

    const entries = ctx.lists.listEntries();
    assert.equal(entries.some((e) => e.list === "blacklist"), false);
    const gray = entries.find((e) => e.list === "graylist");
    assert.ok(gray);
    assert.equal(gray.graylistInsertions, 1);
    assert.equal(ctx.store.countAllGraylistEvents("1.2.3.4/32"), 1);
  });

  it("treats an expiration exactly at now as due", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    ctx.lists.addEntry("blacklist", "1.2.3.4", { expiresAt: "2026-01-01T00:00:00.000Z" });
    const gray = ctx.lists.listEntries().find((e) => e.list === "graylist");
    assert.ok(gray);
    assert.equal(ctx.lists.listEntries().some((e) => e.list === "blacklist" && e.cidr === "1.2.3.4/32"), false);
  });

  it("moves a past expiration on insert instead of leaving it blacklisted", () => {
    const ctx = setup("2026-01-10T00:00:00.000Z");
    const result = ctx.lists.addEntry("blacklist", "1.2.3.4", { expiresAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(result.transition, "graylist_insert");
    assert.equal(result.entry.list, "graylist");
  });

  it("is idempotent when the expiration job runs twice", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    ctx.lists.addEntry("blacklist", "1.2.3.4");
    ctx.setNow("2026-01-06T00:00:00.000Z");
    const first = ctx.lists.processExpirations();
    const second = ctx.lists.processExpirations();
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(ctx.lists.listEntries().filter((e) => e.cidr === "1.2.3.4/32").length, 1);
  });

  it("does not expire permanent blacklist entries", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    ctx.lists.addEntry("blacklist", "1.2.3.4", { permanent: true });
    ctx.setNow("2026-12-31T00:00:00.000Z");
    assert.equal(ctx.lists.processExpirations().length, 0);
    assert.equal(ctx.lists.listEntries()[0].list, "blacklist");
    assert.equal(ctx.lists.listEntries()[0].expiresAt, null);
  });

  it("skips expiration if the IP was removed concurrently", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    const created = ctx.lists.addEntry("blacklist", "1.2.3.4").entry;
    ctx.setNow("2026-01-06T00:00:00.000Z");
    ctx.store.deleteEntry(created.id);
    assert.equal(ctx.lists.processExpirations().length, 0);
  });

  it("skips expiration if the user extended the date before the job ran", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    const created = ctx.lists.addEntry("blacklist", "1.2.3.4").entry;
    ctx.lists.updateExpiration(created.id, { expiresAt: "2026-01-20T00:00:00.000Z" });
    ctx.setNow("2026-01-06T00:00:00.000Z");
    assert.equal(ctx.lists.processExpirations().length, 0);
    assert.equal(ctx.lists.listEntries()[0].list, "blacklist");
  });
});

describe("graylist promotion rule", () => {
  function expireIntoGraylist(ctx, cidr) {
    ctx.lists.addEntry("blacklist", cidr, { expiresAt: toIso(ctx.now()) });
  }

  it("promotes to permanent blacklist after 3 graylist inserts within 20 days", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    expireIntoGraylist(ctx, "1.2.3.4");
    ctx.setNow("2026-01-10T00:00:00.000Z");
    expireIntoGraylist(ctx, "1.2.3.4");
    ctx.setNow("2026-01-18T00:00:00.000Z");
    const third = ctx.lists.addEntry("blacklist", "1.2.3.4", { expiresAt: toIso(ctx.now()) });
    assert.equal(third.transition, "promoted_to_blacklist");
    assert.equal(third.entry.list, "blacklist");
    assert.equal(third.entry.expiresAt, null);
    assert.equal(third.entry.reason, "graylist_threshold_reached");
    const entries = ctx.lists.listEntries();
    assert.equal(entries.some((e) => e.list === "graylist"), false);
    assert.equal(entries.filter((e) => e.cidr === "1.2.3.4/32").length, 1);
  });

  it("does not promote when the oldest event is outside the rolling 20-day window", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    expireIntoGraylist(ctx, "1.2.3.4");
    ctx.setNow("2026-01-10T00:00:00.000Z");
    expireIntoGraylist(ctx, "1.2.3.4");
    ctx.setNow("2026-01-25T00:00:00.000Z");
    const third = ctx.lists.addEntry("blacklist", "1.2.3.4", { expiresAt: toIso(ctx.now()) });
    assert.equal(third.transition, "graylist_insert");
    assert.equal(third.entry.list, "graylist");
    assert.equal(ctx.lists.listEntries().some((e) => e.list === "blacklist" && e.cidr === "1.2.3.4/32"), false);
  });

  it("includes an event exactly 20 days earlier in the window", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    expireIntoGraylist(ctx, "9.9.9.9");
    ctx.setNow("2026-01-05T00:00:00.000Z");
    expireIntoGraylist(ctx, "9.9.9.9");
    ctx.setNow(toIso(new Date(Date.parse("2026-01-01T00:00:00.000Z") + 20 * DAY_MS)));
    const third = ctx.lists.addEntry("blacklist", "9.9.9.9", { expiresAt: toIso(ctx.now()) });
    assert.equal(third.transition, "promoted_to_blacklist");
    assert.equal(third.entry.expiresAt, null);
  });

  it("excludes an event just outside the 20-day window", () => {
    const ctx = setup("2026-01-01T00:00:00.000Z");
    expireIntoGraylist(ctx, "9.9.9.9");
    ctx.setNow("2026-01-05T00:00:00.000Z");
    expireIntoGraylist(ctx, "9.9.9.9");
    ctx.setNow(toIso(new Date(Date.parse("2026-01-01T00:00:00.000Z") + 20 * DAY_MS + 1)));
    const third = ctx.lists.addEntry("blacklist", "9.9.9.9", { expiresAt: toIso(ctx.now()) });
    assert.equal(third.transition, "graylist_insert");
    assert.equal(third.entry.list, "graylist");
  });
});

describe("existing exclusivity and list behavior", () => {
  it("still refuses overlapping whitelist and blacklist entries", () => {
    const { lists } = setup();
    lists.addEntry("whitelist", "10.0.0.0/8");
    assert.throws(() => lists.addEntry("blacklist", "10.1.2.3"), /overlaps/);
  });

  it("removes a graylist IP when it is manually blacklisted", () => {
    const ctx = setup();
    ctx.lists.addEntry("blacklist", "1.2.3.4", { expiresAt: toIso(ctx.now()) });
    assert.ok(ctx.lists.listEntries().find((e) => e.list === "graylist"));
    ctx.addMs(DAY_MS);
    const result = ctx.lists.addEntry("blacklist", "1.2.3.4", { permanent: true });
    assert.equal(result.entry.list, "blacklist");
    assert.equal(result.entry.expiresAt, null);
    assert.equal(ctx.lists.listEntries().some((e) => e.list === "graylist"), false);
  });
});

describe("schema migration", () => {
  it("keeps existing blacklist rows and treats missing expiration as permanent", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list TEXT NOT NULL CHECK (list IN ('whitelist', 'blacklist')),
        cidr TEXT NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (list, cidr)
      );
      INSERT INTO entries (list, cidr, start, end, created_at)
      VALUES ('blacklist', '5.6.7.8/32', 84215040, 84215040, '2026-01-01 00:00:00');
    `);
    migrate(db);
    const row = db.prepare(`SELECT * FROM entries WHERE cidr = '5.6.7.8/32'`).get();
    assert.equal(row.list, "blacklist");
    assert.equal(row.expires_at, null);
    db.prepare(`INSERT INTO entries (list, cidr, start, end, created_at) VALUES ('graylist', '1.1.1.1/32', 16843009, 16843009, '2026-01-02T00:00:00.000Z')`).run();
  });
});
