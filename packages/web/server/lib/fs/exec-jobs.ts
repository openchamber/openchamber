export interface CommandResult {
  command: unknown;
  success: boolean;
  exitCode?: number | undefined;
  stdout?: string;
  stderr?: string;
  outputTruncated?: true;
  error?: unknown;
}

interface ExecJobResult {
  jobId: string;
  status: 'done';
  success: boolean;
  results: CommandResult[];
}

const EXEC_JOB_TTL_MS = 30 * 60 * 1000;
const EXEC_JOB_MAX_ENTRIES = 64;
const EXEC_JOB_MAX_RESULT_BYTES = 16 * 1024 * 1024;

export const createExecJobStore = () => {
  const jobs = new Map<string, { body: string; bytes: number; timer: NodeJS.Timeout; expiresAt: number }>();
  let retainedBytes = 0;

  const remove = (jobId: string) => {
    const entry = jobs.get(jobId);
    if (!entry) return;
    clearTimeout(entry.timer);
    jobs.delete(jobId);
    retainedBytes -= entry.bytes;
  };

  return {
    complete(jobId: string, results: CommandResult[]): string {
      const result: ExecJobResult = { jobId, status: 'done', success: results.every((entry) => entry.success), results };
      const body = JSON.stringify(result);
      const bytes = Buffer.byteLength(body);
      if (bytes > EXEC_JOB_MAX_RESULT_BYTES) return body;

      remove(jobId);
      for (const id of jobs.keys()) {
        if (jobs.size < EXEC_JOB_MAX_ENTRIES && retainedBytes + bytes <= EXEC_JOB_MAX_RESULT_BYTES) break;
        remove(id);
      }
      const timer = setTimeout(() => remove(jobId), EXEC_JOB_TTL_MS);
      timer.unref();
      jobs.set(jobId, { body, bytes, timer, expiresAt: Date.now() + EXEC_JOB_TTL_MS });
      retainedBytes += bytes;
      return body;
    },
    get(jobId: string): string | undefined {
      const entry = jobs.get(jobId);
      if (!entry) return undefined;
      const now = Date.now();
      if (now >= entry.expiresAt) {
        remove(jobId);
        return undefined;
      }
      entry.expiresAt = now + EXEC_JOB_TTL_MS;
      entry.timer.refresh();
      jobs.delete(jobId);
      jobs.set(jobId, entry);
      return entry.body;
    },
  };
};
