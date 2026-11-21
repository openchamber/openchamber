export interface SessionWarmingSnapshot {
  revision: number;
  enabled: boolean;
  minutes: number;
  sessions: { sessionId: string; warmUntil: number | null }[];
}
