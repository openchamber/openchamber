export function fetchCursorSummaryWindow(accessToken: string): Promise<{
  usedPercent: number;
  remainingPercent: number;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string;
} | null>;
