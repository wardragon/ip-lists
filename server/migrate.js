function tableSql(db, name) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  return row?.sql || "";
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list TEXT NOT NULL CHECK (list IN ('whitelist', 'blacklist', 'graylist')),
      cidr TEXT NOT NULL,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      reason TEXT,
      UNIQUE (list, cidr)
    );
  `);

  const sql = tableSql(db, "entries");
  if (sql && !sql.includes("graylist")) {
    db.exec(`
      CREATE TABLE entries_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list TEXT NOT NULL CHECK (list IN ('whitelist', 'blacklist', 'graylist')),
        cidr TEXT NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        reason TEXT,
        UNIQUE (list, cidr)
      );
      INSERT INTO entries_migrated (id, list, cidr, start, end, created_at, expires_at, reason)
      SELECT id, list, cidr, start, end, created_at, NULL, NULL FROM entries;
      DROP TABLE entries;
      ALTER TABLE entries_migrated RENAME TO entries;
    `);
  } else {
    if (!hasColumn(db, "entries", "expires_at")) {
      db.exec(`ALTER TABLE entries ADD COLUMN expires_at TEXT`);
    }
    if (!hasColumn(db, "entries", "reason")) {
      db.exec(`ALTER TABLE entries ADD COLUMN reason TEXT`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS graylist_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cidr TEXT NOT NULL,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      reason TEXT,
      inserted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cidr TEXT NOT NULL,
      event TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_list_cidr ON entries (list, cidr);
    CREATE INDEX IF NOT EXISTS idx_entries_list_expires ON entries (list, expires_at);
    CREATE INDEX IF NOT EXISTS idx_graylist_events_cidr_inserted ON graylist_events (cidr, inserted_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_cidr_created ON audit_events (cidr, created_at);
  `);
}

module.exports = { migrate };
