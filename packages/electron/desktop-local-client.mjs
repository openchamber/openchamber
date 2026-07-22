export const mintAndPersistDesktopLocalClient = async ({ serverHandle, metadata, persistToken }) => {
  if (typeof serverHandle?.createDesktopLocalClient !== 'function') {
    throw new Error('Desktop server did not expose the native local client mint');
  }

  const result = await serverHandle.createDesktopLocalClient(metadata);
  const token = typeof result?.token === 'string' ? result.token.trim() : '';
  if (!token) {
    throw new Error('Desktop server did not mint a local client token');
  }
  await persistToken(token);
  return token;
};
