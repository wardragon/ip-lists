const { parseCidr, findOverlap } = require("./ip");
const {
  DEFAULT_BLACKLIST_TTL_MS,
  GRAYLIST_PROMOTION_COUNT,
  toIso,
  addMs,
  isDue,
  windowStart,
} = require("./time");

const LISTS = new Set(["whitelist", "blacklist", "graylist"]);

function createLists(store, deps = {}) {
  const now = () => (deps.now ? deps.now() : new Date());

  function publicEntry(row, extra = {}) {
    if (!row) return null;
    return {
      id: row.id,
      list: row.list,
      cidr: row.cidr,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      reason: row.reason,
      graylistInsertions: extra.graylistInsertions ?? store.countAllGraylistEvents(row.cidr),
      graylistInsertionsInWindow:
        extra.graylistInsertionsInWindow ??
        store.countGraylistEvents(row.cidr, toIso(windowStart(now())), toIso(now())),
    };
  }

  function others(list, exceptId = null) {
    return store.allEntries().filter((row) => row.list !== list && row.id !== exceptId);
  }

  function conflictFor(parsed, list, exceptId = null) {
    return findOverlap(parsed, others(list, exceptId));
  }

  function resolveBlacklistExpires(options, at) {
    if (options.permanent === true || options.expiresAt === null) return null;
    if (options.expiresAt === undefined) {
      return toIso(addMs(at, DEFAULT_BLACKLIST_TTL_MS));
    }
    const parsed = new Date(options.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw Object.assign(new Error("expiresAt must be a valid date"), { status: 400 });
    }
    return toIso(parsed);
  }

  function processExpirations() {
    const at = now();
    const due = store
      .expiredBlacklistCandidates()
      .filter((row) => isDue(row.expires_at, at))
      .map((row) => row.id);
    const moved = [];
    for (const id of due) {
      const result = expireBlacklistEntry(id, "blacklist_expired");
      if (result) moved.push(result);
    }
    return moved;
  }

  function expireBlacklistEntry(id, reason) {
    const at = now();
    return store.immediate(() => {
      const row = store.getEntry(id);
      if (!row || row.list !== "blacklist" || !isDue(row.expires_at, at)) return null;
      store.deleteEntry(id);
      store.insertAudit({
        cidr: row.cidr,
        event: "blacklist_expired",
        reason,
        created_at: toIso(at),
      });
      return insertGraylistLocked(row, reason, at);
    });
  }

  function insertGraylistLocked(parsed, reason, at) {
    const insertedAt = toIso(at);
    store.insertGraylistEvent({
      cidr: parsed.cidr,
      start: parsed.start,
      end: parsed.end,
      reason,
      inserted_at: insertedAt,
    });
    store.insertAudit({
      cidr: parsed.cidr,
      event: "graylist_insert",
      reason,
      created_at: insertedAt,
    });

    const since = toIso(windowStart(at));
    const windowCount = store.countGraylistEvents(parsed.cidr, since, insertedAt);
    const existingGl = store.getByListAndCidr("graylist", parsed.cidr);

    if (windowCount >= GRAYLIST_PROMOTION_COUNT) {
      if (existingGl) store.deleteEntry(existingGl.id);
      const wl = store.getByListAndCidr("whitelist", parsed.cidr);
      if (wl) store.deleteEntry(wl.id);
      const existingBl = store.getByListAndCidr("blacklist", parsed.cidr);
      if (existingBl) store.deleteEntry(existingBl.id);
      const promoted = store.insertEntry({
        list: "blacklist",
        cidr: parsed.cidr,
        start: parsed.start,
        end: parsed.end,
        created_at: insertedAt,
        expires_at: null,
        reason: "graylist_threshold_reached",
      });
      store.insertAudit({
        cidr: parsed.cidr,
        event: "graylist_threshold_reached",
        reason: "graylist_threshold_reached",
        created_at: insertedAt,
      });
      return { transition: "promoted_to_blacklist", entry: publicEntry(promoted) };
    }

    if (existingGl) {
      const updated = store.touchGraylist(existingGl.id, { created_at: insertedAt, reason });
      return { transition: "graylist_insert", entry: publicEntry(updated) };
    }

    const created = store.insertEntry({
      list: "graylist",
      cidr: parsed.cidr,
      start: parsed.start,
      end: parsed.end,
      created_at: insertedAt,
      expires_at: null,
      reason,
    });
    return { transition: "graylist_insert", entry: publicEntry(created) };
  }

  function addEntry(list, cidrInput, options = {}) {
    if (!LISTS.has(list)) {
      throw Object.assign(new Error("list must be whitelist, blacklist, or graylist"), { status: 400 });
    }
    processExpirations();
    let parsed;
    try {
      parsed = parseCidr(cidrInput);
    } catch (err) {
      throw Object.assign(err, { status: 400 });
    }
    const at = now();

    return store.immediate(() => {
      if (list === "blacklist") {
        const existingGl = store.getByListAndCidr("graylist", parsed.cidr);
        if (existingGl) store.deleteEntry(existingGl.id);
      }

      if (list === "graylist") {
        const existingBl = store.getByListAndCidr("blacklist", parsed.cidr);
        if (existingBl) {
          throw Object.assign(new Error(`${parsed.cidr} is already on the blacklist.`), { status: 409 });
        }
      }

      const conflict = conflictFor(parsed, list);
      if (conflict) {
        const err = new Error(
          `Cannot add ${parsed.cidr} to ${list}: it overlaps ${conflict.cidr} on the ${conflict.list}.`,
        );
        err.status = 409;
        err.conflict = conflict;
        throw err;
      }

      if (list === "graylist") {
        return insertGraylistLocked(parsed, options.reason || "manual", at);
      }

      const expiresAt = list === "blacklist" ? resolveBlacklistExpires(options, at) : null;
      let created;
      try {
        created = store.insertEntry({
          list,
          cidr: parsed.cidr,
          start: parsed.start,
          end: parsed.end,
          created_at: toIso(at),
          expires_at: expiresAt,
          reason: options.reason || (list === "blacklist" ? "manual" : null),
        });
      } catch (err) {
        if (String(err.message).includes("UNIQUE")) {
          throw Object.assign(new Error(`${parsed.cidr} is already on the ${list}.`), { status: 409 });
        }
        throw err;
      }

      if (list === "blacklist" && isDue(created.expires_at, at)) {
        store.deleteEntry(created.id);
        store.insertAudit({
          cidr: created.cidr,
          event: "blacklist_expired",
          reason: "expired_on_insert",
          created_at: toIso(at),
        });
        return insertGraylistLocked(created, "blacklist_expired", at);
      }

      return { transition: "created", entry: publicEntry(created) };
    });
  }

  function updateExpiration(id, options = {}) {
    processExpirations();
    const at = now();
    return store.immediate(() => {
      const existing = store.getEntry(id);
      if (!existing) {
        throw Object.assign(new Error("Entry not found"), { status: 404 });
      }
      if (existing.list !== "blacklist") {
        throw Object.assign(new Error("Only blacklist entries have an expiration date"), { status: 400 });
      }
      const expiresAt = resolveBlacklistExpires(
        options.permanent === true ? { permanent: true } : { expiresAt: options.expiresAt },
        at,
      );
      const updated = store.updateBlacklistExpires(id, expiresAt, options.reason || existing.reason);
      if (isDue(updated.expires_at, at)) {
        store.deleteEntry(updated.id);
        store.insertAudit({
          cidr: updated.cidr,
          event: "blacklist_expired",
          reason: "expired_on_update",
          created_at: toIso(at),
        });
        return insertGraylistLocked(updated, "blacklist_expired", at);
      }
      return { transition: "updated", entry: publicEntry(updated) };
    });
  }

  function moveEntry(id, target, customReason = null) {
    processExpirations();
    const existing = store.getEntry(id);
    if (!existing) {
      throw Object.assign(new Error("Entry not found"), { status: 404 });
    }
    if (!LISTS.has(target)) {
      throw Object.assign(new Error("target must be whitelist, blacklist, or graylist"), { status: 400 });
    }
    if (existing.list === target) {
      return { transition: "unchanged", entry: publicEntry(existing) };
    }

    const at = now();
    return store.immediate(() => {
      const fresh = store.getEntry(id);
      if (!fresh) {
        throw Object.assign(new Error("Entry not found"), { status: 404 });
      }

      const reason = customReason || "manual_move";

      if (target === "graylist") {
        store.deleteEntry(fresh.id);
        return insertGraylistLocked(fresh, reason, at);
      }

      if (target === "blacklist") {
        const existingGl = store.getByListAndCidr("graylist", fresh.cidr);
        if (existingGl && existingGl.id !== fresh.id) store.deleteEntry(existingGl.id);
      }

      const conflict = conflictFor(fresh, target, fresh.id);
      if (conflict) {
        const err = new Error(
          `Cannot move ${fresh.cidr} to ${target}: it overlaps ${conflict.cidr} on the ${conflict.list}.`,
        );
        err.status = 409;
        err.conflict = conflict;
        throw err;
      }

      store.deleteEntry(fresh.id);
      const expiresAt = target === "blacklist" ? resolveBlacklistExpires({}, at) : null;
      const created = store.insertEntry({
        list: target,
        cidr: fresh.cidr,
        start: fresh.start,
        end: fresh.end,
        created_at: toIso(at),
        expires_at: expiresAt,
        reason: reason,
      });
      return { transition: "moved", entry: publicEntry(created) };
    });
  }

  function removeEntry(id) {
    processExpirations();
    const removed = store.immediate(() => store.deleteEntry(id));
    if (!removed) {
      throw Object.assign(new Error("Entry not found"), { status: 404 });
    }
    return removed;
  }

  function listEntries() {
    processExpirations();
    return store.allEntries().map((row) => publicEntry(row));
  }

  return {
    addEntry,
    updateExpiration,
    moveEntry,
    removeEntry,
    listEntries,
    processExpirations,
    publicEntry,
    getEntry(id) {
      processExpirations();
      const row = store.getEntry(id);
      return row ? publicEntry(row) : null;
    },
    listAudit(cidr) {
      return store.listAudit(cidr);
    },
  };
}

module.exports = { createLists, LISTS };
