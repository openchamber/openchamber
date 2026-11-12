// Help > Clear Cache drops only Chromium's HTTP cache. Site storage holds
// device-only settings, pinned sessions and login cookies that exist nowhere
// else, so it stays. Reloading makes every window fetch its assets again.
export async function clearAppCache({ session, windows }) {
  await session.clearCache();
  for (const browserWindow of windows) {
    browserWindow.webContents.reload();
  }
}
