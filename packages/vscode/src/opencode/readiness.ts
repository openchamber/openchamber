import type * as vscode from 'vscode';
import type { ReadyResult } from './types';

let readinessOutputChannel: vscode.OutputChannel | undefined;

export function getReadinessOutputChannel(): vscode.OutputChannel {
  if (!readinessOutputChannel) {
    // Lazy-load vscode so readiness helpers can be unit-tested without the extension host.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscodeApi = require('vscode') as typeof import('vscode');
    readinessOutputChannel = vscodeApi.window.createOutputChannel('OpenChamberManager');
  }
  return readinessOutputChannel;
}

export function resolvePortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    return parsed.port ? parseInt(parsed.port, 10) : null;
  } catch {
    return null;
  }
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getCandidateBaseUrls(serverUrl: string): string[] {
  const normalized = normalizeBaseUrl(serverUrl);
  try {
    const parsed = new URL(normalized);
    const origin = parsed.origin;

    const candidates: string[] = [];
    const add = (url: string) => {
      const v = normalizeBaseUrl(url);
      if (!candidates.includes(v)) candidates.push(v);
    };

    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    // Prefer plain origin. Only keep SDK url when already root.
    add(origin);
    if (normalizedPath === '' || normalizedPath === '/') {
      add(normalized);
    }

    return candidates;
  } catch {
    return [normalized];
  }
}

export async function waitForReady(
  serverUrl: string,
  timeoutMs = 15000,
  authHeaders: Record<string, string> = {}
): Promise<ReadyResult> {
  const outputChannel = getReadinessOutputChannel();
  const start = Date.now();
  const candidates = getCandidateBaseUrls(serverUrl);
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    for (const baseUrl of candidates) {
      attempts += 1;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        // OpenCode readiness check. Use /global/health for OpenCode 1.15.x compatibility.
        const url = new URL(`${baseUrl}/global/health`);
        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json', ...authHeaders },
          signal: controller.signal,
        });

        let body: { healthy?: boolean, version?: string } | null = null;
        try {
          body = (await res.json()) as { healthy?: boolean, version?: string };
        } catch {
          body = null;
        }

        clearTimeout(timeout);
        outputChannel.appendLine(
          `Health check to ${url.toString()} returned ${res.status} with body: ${JSON.stringify(body)}`
        );

        if (res.ok && body?.healthy === true) {
          return { ok: true, baseUrl, elapsedMs: Date.now() - start, attempts, version: body?.version ?? null };
        }
      } catch {
        // ignore
      }
    }

    await new Promise(r => setTimeout(r, 100));
  }

  return { ok: false, elapsedMs: Date.now() - start, attempts, version: null };
}
