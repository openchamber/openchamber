export function readCodexCliLogin(): { accessToken: string; accountId: string | null } | null;

export function signInEmailOf(accessToken: string): string | null;
