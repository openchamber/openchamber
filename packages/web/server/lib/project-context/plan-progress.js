/**
 * How far a plan has got, read from its `## Steps` checklist.
 *
 * Plans carry their progress in the markdown itself: the knowledge tool tells
 * agents to open a plan with a `## Steps` checklist and to tick a step when it
 * is done. That checklist is the only record, so there is no status field to
 * drift from it. Only the `## Steps` section counts: checklists further down
 * (test lists, acceptance criteria) are detail, not progress.
 */

const STEPS_HEADING = /^##\s+steps\s*$/i;
const SECTION_END = /^#{1,2}\s/;
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s/;

/** `{ done, total }` for a plan with a `## Steps` checklist, null otherwise. */
export const parsePlanProgress = (raw) => {
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

/**
 * Plan files read for the list, remembered by modification time and size.
 *
 * The Plans tab re-reads the list while it is open, and agents tick steps with
 * their own file tools, so no write event announces it. Listing therefore
 * costs one `stat` per plan, and a file is read and parsed again only when it
 * changed since the last listing.
 */
export const createPlanSummaryCache = ({ fsPromises, parseTitle }) => {
  const entries = new Map();

  /**
   * `{ title, progress, mtimeMs }`, or null when the file is gone. Other read
   * errors propagate; the caller decides whether one plan may fail the list.
   */
  const summaryOf = async (filePath) => {
    let stat;
    try {
      stat = await fsPromises.stat(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
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
