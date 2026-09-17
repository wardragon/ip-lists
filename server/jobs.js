function startExpirationScheduler(lists, intervalMs = Number(process.env.EXPIRE_INTERVAL_MS) || 60_000) {
  lists.processExpirations();
  const timer = setInterval(() => {
    try {
      lists.processExpirations();
    } catch (err) {
      console.error("expiration job failed", err);
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = { startExpirationScheduler };
