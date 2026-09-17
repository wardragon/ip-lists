const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { migrate } = require("./migrate");

const dataDir = path.join(__dirname, "data");
const defaultPath = path.join(dataDir, "ip-lists.db");

function openDatabase(filePath = process.env.IP_LISTS_DB || defaultPath) {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function createStore(db) {
  const selectEntry = db.prepare(
    `SELECT id, list, cidr, start, end, created_at, expires_at, reason
     FROM entries WHERE id = ?`,
  );
  const selectByListCidr = db.prepare(
    `SELECT id, list, cidr, start, end, created_at, expires_at, reason
     FROM entries WHERE list = ? AND cidr = ?`,
  );
  const selectAll = db.prepare(
    `SELECT id, list, cidr, start, end, created_at, expires_at, reason
     FROM entries
     ORDER BY start ASC, cidr ASC`,
  );
  const selectExpired = db.prepare(
    `SELECT id, list, cidr, start, end, created_at, expires_at, reason
     FROM entries
     WHERE list = 'blacklist' AND expires_at IS NOT NULL`,
  );
  const insertSql = db.prepare(
    `INSERT INTO entries (list, cidr, start, end, created_at, expires_at, reason)
     VALUES (@list, @cidr, @start, @end, @created_at, @expires_at, @reason)`,
  );
  const deleteSql = db.prepare(`DELETE FROM entries WHERE id = ?`);
  const updateExpiresSql = db.prepare(
    `UPDATE entries SET expires_at = @expires_at, reason = COALESCE(@reason, reason) WHERE id = @id AND list = 'blacklist'`,
  );
  const touchGraylistSql = db.prepare(
    `UPDATE entries SET created_at = @created_at, reason = @reason WHERE id = @id AND list = 'graylist'`,
  );
  const insertEventSql = db.prepare(
    `INSERT INTO graylist_events (cidr, start, end, reason, inserted_at)
     VALUES (@cidr, @start, @end, @reason, @inserted_at)`,
  );
  const countEventsSql = db.prepare(
    `SELECT COUNT(*) AS n FROM graylist_events
     WHERE cidr = ? AND inserted_at >= ? AND inserted_at <= ?`,
  );
  const countAllEventsSql = db.prepare(`SELECT COUNT(*) AS n FROM graylist_events WHERE cidr = ?`);
  const insertAuditSql = db.prepare(
    `INSERT INTO audit_events (cidr, event, reason, created_at)
     VALUES (@cidr, @event, @reason, @created_at)`,
  );
  const selectAuditSql = db.prepare(
    `SELECT id, cidr, event, reason, created_at FROM audit_events WHERE cidr = ? ORDER BY created_at DESC, id DESC`,
  );

  function getEntry(id) {
    return selectEntry.get(id) || null;
  }

  return {
    db,
    allEntries() {
      return selectAll.all();
    },
    getEntry,
    getByListAndCidr(list, cidr) {
      return selectByListCidr.get(list, cidr) || null;
    },
    expiredBlacklistCandidates() {
      return selectExpired.all();
    },
    insertEntry({ list, cidr, start, end, created_at, expires_at = null, reason = null }) {
      const info = insertSql.run({
        list,
        cidr,
        start,
        end,
        created_at,
        expires_at,
        reason,
      });
      return getEntry(info.lastInsertRowid);
    },
    deleteEntry(id) {
      const existing = getEntry(id);
      if (!existing) return null;
      deleteSql.run(id);
      return existing;
    },
    updateBlacklistExpires(id, expires_at, reason = null) {
      updateExpiresSql.run({ id, expires_at, reason });
      return getEntry(id);
    },
    touchGraylist(id, { created_at, reason }) {
      touchGraylistSql.run({ id, created_at, reason });
      return getEntry(id);
    },
    insertGraylistEvent(row) {
      insertEventSql.run(row);
    },
    countGraylistEvents(cidr, sinceIso, untilIso) {
      return countEventsSql.get(cidr, sinceIso, untilIso).n;
    },
    countAllGraylistEvents(cidr) {
      return countAllEventsSql.get(cidr).n;
    },
    insertAudit(row) {
      insertAuditSql.run(row);
    },
    listAudit(cidr) {
      return selectAuditSql.all(cidr);
    },
    immediate(fn) {
      return db.transaction(fn).immediate();
    },
  };
}

module.exports = { openDatabase, createStore, defaultPath };
