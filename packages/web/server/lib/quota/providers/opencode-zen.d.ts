export type OpenCodeZenCredential = { apiKey: string } | { accessToken: string; orgID: string };

type OpenCodeZenWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  value: { kind: 'requests'; count: number } | { kind: 'spend'; spent: number; limit: number | null };
};

export function fetchOpenCodeZenUsage(credential: OpenCodeZenCredential, fetchImpl?: typeof fetch): Promise<{
  windows: Record<string, OpenCodeZenWindow>;
  models: Record<string, { windows: Record<string, OpenCodeZenWindow> }>;
}>;
