import { isMobileSurfaceRuntime } from './runtimeSurface';

const CONTROL_STREAM_HEARTBEAT_INTERVAL_MS = 25_000;
const MOBILE_CONTROL_STREAM_HEARTBEAT_INTERVAL_MS = 30_000;

const controlStreamHeartbeatIntervalMs = () => (
  isMobileSurfaceRuntime() ? MOBILE_CONTROL_STREAM_HEARTBEAT_INTERVAL_MS : CONTROL_STREAM_HEARTBEAT_INTERVAL_MS
);

export const controlStreamSilenceLimitMs = () => 2 * controlStreamHeartbeatIntervalMs();

export const buildControlStreamQuery = (canControlBrowser: boolean) => {
  const heartbeat = String(controlStreamHeartbeatIntervalMs());
  return canControlBrowser ? { browser: '1', heartbeat } : { heartbeat };
};
