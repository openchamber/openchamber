export async function refreshInstalledAppsCache({
  cachePath,
  now,
  version,
  apps,
  buildApps,
  mkdir,
  writeFile,
  emit,
}) {
  const installedApps = await buildApps(apps);
  await mkdir();
  await writeFile(cachePath, JSON.stringify({ version, updatedAt: now, apps: installedApps }, null, 2));
  emit('openchamber:installed-apps-updated', installedApps);
}

export function getInstalledAppsCacheResponse({
  cache,
  now,
  version,
  ttlSecs,
  force = false,
  supported = true,
  refresh,
  log,
}) {
  if (!supported) {
    return { apps: [], hasCache: false, isCacheStale: false, supported: false };
  }

  const cachedApps = Array.isArray(cache?.apps) ? cache.apps : [];
  const hasCache = Boolean(cache);
  const isCacheStale = !cache
    || cache.version !== version
    || (now - Number(cache.updatedAt || 0)) > ttlSecs;

  if (!hasCache || isCacheStale || force) {
    void refresh().catch((error) => {
      log.warn('[electron] failed to refresh installed apps cache:', error);
    });
  }

  return { apps: cachedApps, hasCache, isCacheStale };
}
