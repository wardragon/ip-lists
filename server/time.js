const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BLACKLIST_TTL_MS = 5 * DAY_MS;
const GRAYLIST_WINDOW_MS = 20 * DAY_MS;
const GRAYLIST_PROMOTION_COUNT = 3;

function toIso(value) {
  return new Date(value).toISOString();
}

function addMs(value, ms) {
  return new Date(new Date(value).getTime() + ms);
}

function isDue(expiresAt, now) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

function windowStart(now) {
  return new Date(new Date(now).getTime() - GRAYLIST_WINDOW_MS);
}

module.exports = {
  DAY_MS,
  DEFAULT_BLACKLIST_TTL_MS,
  GRAYLIST_WINDOW_MS,
  GRAYLIST_PROMOTION_COUNT,
  toIso,
  addMs,
  isDue,
  windowStart,
};
