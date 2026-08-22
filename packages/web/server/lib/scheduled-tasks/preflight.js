import { execFile as nodeExecFile } from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

export class PreflightDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreflightDeniedError";
  }
}

const defaultConfigPath = () =>
  path.join(os.homedir(), ".config", "openchamber", "preflight.json");

const parseConfig = (raw) => {
  const value = JSON.parse(raw);
  if (
    !value ||
    !Array.isArray(value.command) ||
    value.command.length === 0 ||
    !value.command.every((part) => String(part) === part && part.length > 0)
  ) {
    throw new Error("preflight command must be a non-empty argv array");
  }
  return {
    command: value.command,
    timeoutMs:
      Number.isInteger(value.timeoutMs) && value.timeoutMs > 0
        ? Math.min(value.timeoutMs, MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS,
    onError: value.onError === "allow" ? "allow" : "deny",
    applyTo: value.applyTo === "scheduled" ? "scheduled" : "all",
  };
};

const message = (error) =>
  String(error?.message || error || "preflight failed").trim() ||
  "preflight failed";

export const createScheduledTaskPreflight = ({
  readFile = nodeReadFile,
  execFile = nodeExecFile,
  configPath = defaultConfigPath(),
  logger = console,
} = {}) => ({
  async evaluate(context) {
    let config;
    try {
      config = parseConfig(await readFile(configPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new PreflightDeniedError(
        `preflight configuration failed: ${message(error)}`,
      );
    }
    if (config.applyTo === "scheduled" && context.reason !== "scheduled")
      return;
    try {
      await new Promise((resolve, reject) => {
        const [file, ...args] = config.command;
        const child = execFile(
          file,
          args,
          {
            cwd: context.projectPath,
            shell: false,
            windowsHide: true,
            timeout: config.timeoutMs,
            maxBuffer: 8 * 1024,
          },
          (error, stdout) => {
            if (error) return reject(error);
            try {
              const result = JSON.parse(String(stdout || "").trim());
              if (result?.allow === false)
                return reject(
                  new PreflightDeniedError(result.reason || "preflight denied"),
                );
            } catch {
              // Zero exit without JSON is an allow.
            }
            return resolve();
          },
        );
        child.stdin?.end(`${JSON.stringify(context)}\n`);
      });
    } catch (error) {
      if (error instanceof PreflightDeniedError) throw error;
      const reason = `preflight denied: ${message(error)}`;
      logger.warn?.("[scheduled-tasks] preflight command failed", reason);
      if (config.onError === "allow") return;
      throw new PreflightDeniedError(reason);
    }
  },
});
