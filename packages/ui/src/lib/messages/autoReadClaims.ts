const CLAIMS_KEY = 'autoReadAloudClaims';
const LOCK_NAME = 'openchamber-auto-read-aloud';
const MAX_CLAIMS = 50;

const takeClaim = (storage: Storage, messageId: string): boolean => {
  const claims = (storage.getItem(CLAIMS_KEY) ?? '').split('\n').filter(Boolean);
  if (claims.includes(messageId)) return false;
  storage.setItem(CLAIMS_KEY, [...claims, messageId].slice(-MAX_CLAIMS).join('\n'));
  return true;
};

export const claimReplyForAutoRead = async (messageId: string): Promise<boolean> => {
  const storage = globalThis.window?.localStorage;
  if (!storage) return true;
  const locks = globalThis.navigator?.locks;
  if (!locks) return takeClaim(storage, messageId);
  return locks.request(LOCK_NAME, () => takeClaim(storage, messageId));
};
