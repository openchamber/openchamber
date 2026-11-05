const OPEN_TAG = '<openui-lang>';
const CLOSE_TAG = '</openui-lang>';
const OPEN_LINE = /^ {0,3}<openui-lang>/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A fence named after the library instead of its language.
const SHORT_FENCE = /^( {0,3}(?:`{3,}|~{3,}))[ \t]*openui[ \t\r]*$/;
// A fence with no language, or one labelled as plain text.
const PLAIN_FENCE = /^( {0,3}(?:`{3,}|~{3,}))[ \t]*(?:text|plaintext|txt|md|markdown)?[ \t\r]*$/i;
// The first statement every UI program starts with, indent allowed.
const UI_PROGRAM = /^\s*root = Stack\(/;

/** Whether the first non-empty line from `from` on opens a UI program. */
function startsUiProgram(lines: string[], from: number): boolean {
  for (let index = from; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    return UI_PROGRAM.test(lines[index]);
  }
  return false;
}

/**
 * Turns the ways models mislabel a UI block into an `openui-lang` fence; the
 * program inside is fine in every case.
 *
 * - `<openui-lang>…</openui-lang>`: weaker models read the guidance inside XML
 *   context tags and wrap a block in a tag of the same shape. A tag opens only
 *   at the start of a line outside code fences, so a sample of the tag in code
 *   stays text. An unclosed tag becomes an unclosed fence, which draws as a
 *   streaming block.
 * - A fence opened as `openui`, the library's name.
 * - A fence left without a language, or labelled as plain text, when the block
 *   starts with a UI program: the model dropped the label but the program is
 *   right, so showing the source instead of the block would lose the answer.
 *   Only the fence line changes, and only when the line right after it (past
 *   blank lines) really is a program.
 */
export function fenceUiBlocks(text: string): string {
  // Cheap pre-check: full text without either marker cannot need a rewrite.
  if (!text.includes('openui') && !text.includes('root = Stack(')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let outerFence: string | null = null;
  let inTag = false;

  const takeBody = (line: string) => {
    const close = line.indexOf(CLOSE_TAG);
    if (close < 0) {
      out.push(line);
      return;
    }
    const body = line.slice(0, close);
    const after = line.slice(close + CLOSE_TAG.length).trim();
    if (body.trim()) out.push(body);
    out.push('```');
    if (after) out.push(after);
    inTag = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inTag) {
      takeBody(line);
      continue;
    }
    const fence = FENCE.exec(line)?.[1];
    if (outerFence) {
      if (fence && fence[0] === outerFence[0] && fence.length >= outerFence.length && !line.trim().slice(fence.length)) outerFence = null;
      out.push(line);
      continue;
    }
    if (fence) {
      outerFence = fence;
      const short = SHORT_FENCE.exec(line);
      if (short) {
        out.push(`${short[1]}openui-lang`);
        continue;
      }
      const plain = PLAIN_FENCE.exec(line);
      if (plain && startsUiProgram(lines, index + 1)) {
        out.push(`${plain[1]}openui-lang`);
        continue;
      }
      out.push(line);
      continue;
    }
    if (!OPEN_LINE.test(line)) {
      out.push(line);
      continue;
    }
    out.push('```openui-lang');
    inTag = true;
    const rest = line.slice(line.indexOf(OPEN_TAG) + OPEN_TAG.length);
    if (rest.trim()) takeBody(rest);
  }
  return out.join('\n');
}
