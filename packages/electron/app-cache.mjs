export async function clearAppCache({ session, windows }) {
  await session.clearCache();
  for (const browserWindow of windows) {
    browserWindow.webContents.reload();
  }
}
