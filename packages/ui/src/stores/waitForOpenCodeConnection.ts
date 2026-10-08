/**
 * Waits for OpenCode to answer its health probe after a config-driven restart.
 *
 * The agents, commands and skills stores refresh configuration by asking
 * OpenCode to reload; the server is briefly unreachable while it comes back.
 * This polls `opencodeClient.checkHealth`, reporting progress through the
 * config-update banner, and gives up after a bounded maximum so a refresh
 * cannot hang forever.
 */

import { updateConfigUpdateMessage } from "@/lib/configUpdate";
import { opencodeClient } from "@/lib/opencode/client";

const MAX_HEALTH_WAIT_MS = 20000;
const FAST_HEALTH_POLL_INTERVAL_MS = 300;
const FAST_HEALTH_POLL_ATTEMPTS = 4;
const FAST_HEALTH_POLL_WINDOW_MS = 1200;
const SLOW_HEALTH_POLL_BASE_MS = 800;
const SLOW_HEALTH_POLL_INCREMENT_MS = 200;
const SLOW_HEALTH_POLL_MAX_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForOpenCodeConnection(delayMs?: number): Promise<void> {
  const initialPause = delayMs !== undefined && delayMs > 0
    ? Math.min(delayMs, FAST_HEALTH_POLL_INTERVAL_MS)
    : 0;

  if (initialPause > 0) {
    await sleep(initialPause);
  }

  const start = Date.now();
  let attempt = 0;
  let lastError = null;

  while (Date.now() - start < MAX_HEALTH_WAIT_MS) {
    attempt += 1;
    updateConfigUpdateMessage(`Waiting for OpenCode… (attempt ${attempt})`);

    try {
      const isHealthy = await opencodeClient.checkHealth();
      if (isHealthy) {
        return;
      }
      lastError = new Error("OpenCode health check reported not ready");
    } catch (error) {
      lastError = error;
    }

    const elapsed = Date.now() - start;

    const waitMs =
      attempt <= FAST_HEALTH_POLL_ATTEMPTS && elapsed < FAST_HEALTH_POLL_WINDOW_MS
        ? FAST_HEALTH_POLL_INTERVAL_MS
        : Math.min(
            SLOW_HEALTH_POLL_BASE_MS +
              Math.max(0, attempt - FAST_HEALTH_POLL_ATTEMPTS) * SLOW_HEALTH_POLL_INCREMENT_MS,
            SLOW_HEALTH_POLL_MAX_MS,
          );

    await sleep(waitMs);
  }

  throw lastError || new Error("OpenCode did not become ready in time");
}
