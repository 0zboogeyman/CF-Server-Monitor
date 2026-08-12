const REALTIME_STATE_CACHE_TTL_MS = 4 * 60 * 1000;
const MAX_REALTIME_STATE_CACHE_ENTRIES = 100;

const realtimeStateCache = new Map();

function normalizeServerIds(serverIds) {
  return Array.from(new Set(
    (Array.isArray(serverIds) ? serverIds : [])
      .map(serverId => String(serverId || '').trim())
      .filter(Boolean)
  ));
}

function getCacheKey(serverIds) {
  return normalizeServerIds(serverIds).join('\u0000');
}

function pruneRealtimeStateCache(now = Date.now()) {
  for (const [key, entry] of realtimeStateCache) {
    if (!entry || now - entry.cachedAt > REALTIME_STATE_CACHE_TTL_MS) {
      realtimeStateCache.delete(key);
    }
  }

  while (realtimeStateCache.size > MAX_REALTIME_STATE_CACHE_ENTRIES) {
    const oldestKey = realtimeStateCache.keys().next().value;
    if (oldestKey === undefined) break;
    realtimeStateCache.delete(oldestKey);
  }
}

function normalizeRealtimeState(state = {}) {
  return {
    latestReportUpdates: Array.isArray(state.latestReportUpdates) ? state.latestReportUpdates : [],
    latencyWindows: Array.isArray(state.latencyWindows) ? state.latencyWindows : []
  };
}

export function getCachedRealtimeState(serverIds, now = Date.now()) {
  const key = getCacheKey(serverIds);
  if (!key) return null;

  pruneRealtimeStateCache(now);
  const entry = realtimeStateCache.get(key);
  if (!entry || now - entry.cachedAt > REALTIME_STATE_CACHE_TTL_MS) return null;

  return {
    ...normalizeRealtimeState(entry),
    cacheHit: true,
    cacheAgeMs: Math.max(0, now - entry.cachedAt)
  };
}

export function cacheRealtimeState(serverIds, state, cachedAt = Date.now()) {
  const key = getCacheKey(serverIds);
  if (!key) return;

  pruneRealtimeStateCache(cachedAt);
  realtimeStateCache.delete(key);
  realtimeStateCache.set(key, {
    cachedAt,
    ...normalizeRealtimeState(state)
  });
}
