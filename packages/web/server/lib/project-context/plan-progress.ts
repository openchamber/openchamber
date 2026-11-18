import type fs from 'node:fs/promises';
import { hasErrorCode } from './contracts.js';

export interface PlanProgress {
  done: number;
  total: number;
}

interface PlanSummary {
  title: string;
  progress: PlanProgress | null;
  mtimeMs: number;
}

interface PlanSummaryCacheDependencies {
  fsPromises: Pick<typeof fs, 'stat' | 'readFile'>;
  parseTitle: (raw: string) => string;
}

const STEPS_HEADING = /^##\s+steps\s*$/i;
const SECTION_END = /^#{1,2}\s/;
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s/;

export const parsePlanProgress = (raw: string): PlanProgress | null => {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => STEPS_HEADING.test(line));
  if (start === -1) return null;
  let done = 0;
  let total = 0;
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line)) break;
    const item = line.match(CHECKLIST_ITEM);
    if (!item) continue;
    total += 1;
    if (item[1] !== ' ') done += 1;
  }
  return total === 0 ? null : { done, total };
};

export const createPlanSummaryCache = ({ fsPromises, parseTitle }: PlanSummaryCacheDependencies) => {
  const entries = new Map<string, { mtimeMs: number; size: number; summary: PlanSummary }>();

  const summaryOf = async (filePath: string) => {
    let stat;
    try {
      stat = await fsPromises.stat(filePath);
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        entries.delete(filePath);
        return null;
      }
      throw error;
    }
    const cached = entries.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.summary;
    }
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const summary = { title: parseTitle(raw), progress: parsePlanProgress(raw), mtimeMs: stat.mtimeMs };
    entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
    return summary;
  };

  return { summaryOf };
};
