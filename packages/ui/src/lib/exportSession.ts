import type { Message, Part } from '@opencode-ai/sdk/v2';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeRuntime, openDesktopPath, revealDesktopPath, saveDesktopMarkdownFile } from '@/lib/desktop';
import { getRevealLabelKey } from '@/lib/utils';

type SessionMessageRecord = { info: Message; parts: Part[] };

export type ChildSessionExport = {
  title: string;
  agent?: string;
  records: SessionMessageRecord[];
  children: ChildSessionExport[];
};

function formatTimestamp(timestamp: number | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return '';
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const monthPart = date.toLocaleString(undefined, { month: 'short' });
  const dayPart = date.getDate();
  const yearPart = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${monthPart} ${dayPart}, ${yearPart}, ${hours}:${minutes}`;
}

function formatAssistantModel(record: SessionMessageRecord): string {
  if (record.info.role === 'user') {
    return '';
  }

  const providerID = typeof record.info.providerID === 'string' ? record.info.providerID.trim() : '';
  const modelID = typeof record.info.modelID === 'string' ? record.info.modelID.trim() : '';

  if (providerID && modelID) {
    return `${providerID}/${modelID}`;
  }

  return modelID || providerID;
}

function formatMessageHeader(record: SessionMessageRecord): string {
  const label = record.info.role === 'user' ? 'User' : 'Assistant';
  const timestamp = formatTimestamp(record.info.time?.created);
  const assistantModel = formatAssistantModel(record);
  const details = timestamp && assistantModel
    ? `${timestamp} (${assistantModel})`
    : (timestamp || assistantModel);

  return details ? `**${label}**\n\n*${details}*` : `**${label}**`;
}

function extractTextFromParts(parts: Part[]): string {
  return parts
    .filter((p): p is Part & { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

function formatMessageAsMarkdown(record: SessionMessageRecord): string {
  const role = formatMessageHeader(record);
  const text = extractTextFromParts(record.parts).trim();

  if (!text) return '';
  return `${role}\n\n${text}`;
}

function formatChildSessionAsMarkdown(child: ChildSessionExport, depth: number): string {
  const heading = '#'.repeat(Math.min(depth + 1, 6));
  const agentLabel = child.agent ? ` — ${child.agent}` : '';
  const childHeader = `${heading} Sub-agent: ${child.title}${agentLabel}\n\n---\n\n`;

  const childBody = child.records
    .map(formatMessageAsMarkdown)
    .filter(Boolean)
    .join('\n\n---\n\n');

  const parts = [childHeader + childBody];

  for (const grandchild of child.children) {
    parts.push(formatChildSessionAsMarkdown(grandchild, depth + 1));
  }

  return parts.join('\n\n---\n\n');
}

export function formatSessionAsMarkdown(
  messages: SessionMessageRecord[],
  sessionTitle?: string | null,
  childSessions?: ChildSessionExport[],
): string {
  const title = sessionTitle?.trim() || 'Session';
  const date = new Date().toISOString().split('T')[0];

  const header = `# ${title}\n\n*Exported on ${date}*\n\n---\n\n`;

  const body = messages
    .map(formatMessageAsMarkdown)
    .filter(Boolean)
    .join('\n\n---\n\n');

  let result = header + body;

  if (childSessions && childSessions.length > 0) {
    const childMarkdown = childSessions
      .map((child) => formatChildSessionAsMarkdown(child, 1))
      .join('\n\n---\n\n');
    result += '\n\n---\n\n' + childMarkdown;
  }

  return result;
}

export function downloadAsMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function saveAsMarkdownDesktop(content: string, filename: string): Promise<string | null> {
  const desktopPath = await saveDesktopMarkdownFile(filename, content);
  if (desktopPath) {
    return desktopPath;
  }

  if (!isVSCodeRuntime()) {
    return null;
  }

  try {
    const response = await fetch('/api/vscode/save-markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: filename, content }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as { saved?: boolean; path?: string };
    if (payload.saved !== true) {
      return null;
    }

    const savedPath = typeof payload.path === 'string' ? payload.path.trim() : '';
    return savedPath.length > 0 ? savedPath : null;
  } catch {
    return null;
  }
}

export async function revealExportedMarkdown(path: string): Promise<boolean> {
  const runtimeFiles = getRegisteredRuntimeAPIs()?.files;
  if (runtimeFiles?.revealPath) {
    try {
      const result = await runtimeFiles.revealPath(path);
      return Boolean(result?.success);
    } catch {
      return false;
    }
  }

  if (await revealDesktopPath(path)) {
    return true;
  }

  return openDesktopPath(path);
}

export function getExportRevealLabelKey() {
  return getRevealLabelKey();
}

export function buildExportFilename(sessionTitle?: string | null): string {
  const base = sessionTitle?.trim() || 'session';
  const safe = base
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const normalizedBase = safe || 'session';
  const date = new Date().toISOString().split('T')[0];
  return `${normalizedBase}-${date}.md`;
}
