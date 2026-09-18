const express = require("express");
const cors = require("cors");
const { openDatabase, createStore } = require("./db");
const { createLists } = require("./lists");
const { startExpirationScheduler } = require("./jobs");

const store = createStore(openDatabase());
const lists = createLists(store);

const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(cors());
app.use(express.json());

function publicEntry(row) {
  if (!row) return null;
  if (row.createdAt) return row;
  return lists.publicEntry(row);
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const body = { error: err.message || "Internal error" };
  if (err.conflict) body.conflict = publicEntry(err.conflict);
  res.status(status).json(body);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/entries", (_req, res) => {
  try {
    res.json({ entries: lists.listEntries() });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/entries", (req, res) => {
  try {
    const result = lists.addEntry(req.body?.list, req.body?.cidr, {
      expiresAt: Object.prototype.hasOwnProperty.call(req.body || {}, "expiresAt")
        ? req.body.expiresAt
        : undefined,
      permanent: req.body?.permanent === true,
      reason: req.body?.reason,
    });
    res.status(201).json({
      entry: publicEntry(result.entry),
      transition: result.transition,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.patch("/api/entries/:id", (req, res) => {
  try {
    const result = lists.updateExpiration(Number(req.params.id), {
      expiresAt: Object.prototype.hasOwnProperty.call(req.body || {}, "expiresAt")
        ? req.body.expiresAt
        : undefined,
      permanent: req.body?.permanent === true,
    });
    res.json({
      entry: publicEntry(result.entry),
      transition: result.transition,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/entries/:id/move", (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = lists.getEntry(id);
    if (!existing) {
      const err = new Error("Entry not found");
      err.status = 404;
      throw err;
    }
    const target =
      req.body?.target ||
      (existing.list === "whitelist" ? "blacklist" : existing.list === "blacklist" ? "whitelist" : null);
    if (!target) {
      const err = new Error("target must be whitelist, blacklist, or graylist");
      err.status = 400;
      throw err;
    }
    const result = lists.moveEntry(id, target, req.body?.reason);
    res.json({
      entry: publicEntry(result.entry),
      transition: result.transition,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete("/api/entries/:id", (req, res) => {
  try {
    const removed = lists.removeEntry(Number(req.params.id));
    res.json({ entry: publicEntry(removed) });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/audit/:cidr", (req, res) => {
  try {
    res.json({ events: lists.listAudit(req.params.cidr) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/jobs/expire", (_req, res) => {
  try {
    const moved = lists.processExpirations().map((item) => ({
      entry: publicEntry(item.entry),
      transition: item.transition,
    }));
    res.json({ moved });
  } catch (err) {
    sendError(res, err);
  }
});

if (require.main === module) {
  startExpirationScheduler(lists);
  app.listen(PORT, () => {
    console.log(`ip-lists API on http://localhost:${PORT}`);
  });
}

module.exports = { app, lists };
