/**
 * Shareable diff URLs via the open-source `critique` CLI (critique.work).
 *
 * Mirrors kimaki's approach: run `bunx critique --web <title> --json` in the
 * project directory (or `--stdin` for a patch body) and parse `{ url, id }`.
 * No package dependency — `bunx` resolves critique on demand.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CRITIQUE_TIMEOUT_MS = 30_000;
const CRITIQUE_STDIN_TIMEOUT_MS = 15_000;

/**
 * Parse critique --json output. Critique prints progress to stderr/stdout and
 * a JSON object with `{ url, id }` (or `{ error }`). Fall back to scraping a
 * critique.work URL from the raw text.
 *
 * @param {string} output
 * @returns {{ url: string, id: string } | { error: string } | undefined}
 */
export function parseCritiqueOutput(output) {
  const text = String(output ?? '');
  const lines = text.trim().split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.error) return { error: String(parsed.error) };
      if (parsed?.url && parsed?.id) {
        return { url: String(parsed.url), id: String(parsed.id) };
      }
    } catch {
      // not JSON — keep scanning
    }
  }
  const urlMatch = text.match(/https?:\/\/critique\.work\/[^\s)"']+/);
  if (!urlMatch) return undefined;
  const url = urlMatch[0];
  const idMatch = url.match(/\/v\/([a-f0-9]+)/i);
  if (!idMatch?.[1]) return { error: url };
  return { url, id: idMatch[1] };
}

function runCritique({ args, cwd, stdin = null, timeoutMs = CRITIQUE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn('bunx', ['--bun', 'critique', ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr: stderr || (err?.message ?? 'spawn failed'),
        error: err,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    if (stdin != null) {
      child.stdin.on('error', () => { /* ignore EPIPE when critique exits early */ });
      child.stdin.end(String(stdin));
    } else {
      child.stdin.end();
    }
  });
}

function resultFromProcess(proc) {
  const parsed = parseCritiqueOutput(`${proc.stdout}\n${proc.stderr}`);
  if (parsed) return parsed;
  const combined = `${proc.stderr}\n${proc.stdout}`.trim();
  if (/ENOENT|command not found|bunx: not found/i.test(combined) || proc.error?.code === 'ENOENT') {
    return { error: 'critique not available (need bun/bunx)' };
  }
  if (!proc.ok) {
    return { error: `Failed to generate diff URL: ${(combined || `exit ${proc.code}`).slice(0, 200)}` };
  }
  return { error: 'critique returned no URL' };
}

/**
 * Upload the current git working-tree diff and return a shareable critique URL.
 *
 * @param {{ title: string, cwd: string, filters?: string[], timeoutMs?: number }} opts
 */
export async function uploadGitDiffViaCritique({
  title,
  cwd,
  filters = [],
  timeoutMs = CRITIQUE_TIMEOUT_MS,
}) {
  if (!cwd) return { error: 'no project directory' };
  try {
    if (!fs.existsSync(cwd)) return { error: 'project directory does not exist' };
  } catch {
    return { error: 'project directory is not accessible' };
  }
  const args = ['--web', String(title || 'OpenChamber diff'), '--json'];
  for (const filter of filters) {
    if (filter) args.push('--filter', String(filter));
  }
  const proc = await runCritique({ args, cwd, timeoutMs });
  return resultFromProcess(proc);
}

/**
 * Upload a unified-diff / patch body via critique --stdin.
 *
 * @param {{ patch: string, title: string, cwd: string, timeoutMs?: number }} opts
 */
export async function uploadPatchViaCritique({
  patch,
  title,
  cwd,
  timeoutMs = CRITIQUE_STDIN_TIMEOUT_MS,
}) {
  if (!cwd) return { error: 'no project directory' };
  if (!String(patch ?? '').trim()) return { error: 'empty patch' };
  try {
    if (!fs.existsSync(cwd)) return { error: 'project directory does not exist' };
  } catch {
    return { error: 'project directory is not accessible' };
  }
  const args = ['--stdin', '--web', String(title || 'OpenChamber diff'), '--json'];
  const proc = await runCritique({
    args,
    cwd,
    stdin: String(patch),
    timeoutMs,
  });
  return resultFromProcess(proc);
}

export function critiqueOgImageUrl(id) {
  if (!id) return null;
  return `https://critique.work/og/${id}.png`;
}

/** Compact agent-facing instructions so Discord sessions auto-share diff URLs. */
export function buildCritiqueInstructions() {
  return [
    '<diffs>',
    'After editing any files, generate a shareable diff URL with the critique CLI and include that URL in your final user-facing message.',
    'The user cannot see tool output directly — copy the critique.work URL into your reply yourself.',
    'When the user asks to see a diff or review changes, prefer a critique URL over raw `git diff` text.',
    '',
    'Typical usage:',
    '  bunx --bun critique --web "Short title describing the changes" --json',
    '  bunx --bun critique --web "Title" --filter "path/to/file1.ts" --filter "path/to/file2.ts" --json',
    '  bunx --bun critique --staged --web "Staged changes" --json',
    '  bunx --bun critique main --web "Branch changes" --json',
    '  bunx --bun critique --commit HEAD --web "Latest commit" --json',
    '',
    'If you edited files during this turn, always run critique at the end (even if the user did not ask), filtering to the files you touched. Skip only for purely read-only turns.',
    'critique is open source (https://github.com/remorses/critique); URLs are unique/ephemeral and hosted at critique.work.',
    '</diffs>',
  ].join('\n');
}
