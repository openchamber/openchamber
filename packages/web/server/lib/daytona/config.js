// Daytona sandbox configuration module.
//
// Reads environment variables and returns a resolved configuration object
// for the Daytona sandbox orchestration service. The service is considered
// enabled only when DAYTONA_API_KEY is present.

const DEFAULT_API_URL = 'https://app.daytona.io';
const DEFAULT_SANDBOX_IMAGE = 'daytonaio/ai-opencode:latest';
const DEFAULT_TIMEOUT_MS = 600000; // 10 minutes
const DEFAULT_OPENCODE_PORT = 4096;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Resolve Daytona configuration from environment variables.
 *
 * @returns {{
 *   enabled: boolean,
 *   apiKey: string | null,
 *   apiUrl: string,
 *   sandboxImage: string,
 *   timeoutMs: number,
 *   openCodePort: number,
 * }}
 */
export const resolveDaytonaConfig = () => {
  const apiKey = process.env.DAYTONA_API_KEY?.trim() || null;
  const apiUrl = process.env.DAYTONA_API_URL?.trim() || DEFAULT_API_URL;
  const sandboxImage = process.env.DAYTONA_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE;
  const timeoutMs = parsePositiveInt(process.env.DAYTONA_SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const openCodePort = parsePositiveInt(process.env.DAYTONA_OPENCODE_PORT, DEFAULT_OPENCODE_PORT);

  return {
    enabled: apiKey !== null && apiKey.length > 0,
    apiKey,
    apiUrl,
    sandboxImage,
    timeoutMs,
    openCodePort,
  };
};
