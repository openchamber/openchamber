type MistralUsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string;
};

export function fetchMistralUsage(apiKey: string, fetchImpl?: typeof fetch): Promise<{
  windows: Record<string, MistralUsageWindow>;
  planLabel: string | null;
}>;
