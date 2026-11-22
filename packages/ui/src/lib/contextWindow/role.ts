const CONTEXT_WINDOW_PARAM = 'contextWindow';

const WINDOW_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export const isWindowId = (value: string | null): value is string => value !== null && WINDOW_ID_PATTERN.test(value);

const readOwnerId = (): string | null => {
  const value = new URLSearchParams(globalThis.location?.search ?? '').get(CONTEXT_WINDOW_PARAM)?.trim() ?? null;
  return isWindowId(value) ? value : null;
};

let ownerId: string | null | undefined;

export const contextWindowOwnerId = (): string | null => {
  if (ownerId === undefined) ownerId = readOwnerId();
  return ownerId;
};

export const isContextWindow = (): boolean => contextWindowOwnerId() !== null;

export const buildContextWindowUrl = (pageUrl: string, owner: string): string => {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set(CONTEXT_WINDOW_PARAM, owner);
  return url.toString();
};

export const isContextWindowUrl = (href: string, owner: string, origin: string): boolean => {
  try {
    const url = new URL(href);
    return url.origin === origin && url.searchParams.get(CONTEXT_WINDOW_PARAM) === owner;
  } catch {
    return false;
  }
};
