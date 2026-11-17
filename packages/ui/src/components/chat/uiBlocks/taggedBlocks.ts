const OPEN_TAG = '<openui-lang>';
const CLOSE_TAG = '</openui-lang>';
const OPEN_LINE = /^ {0,3}<openui-lang>/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SHORT_FENCE = /^( {0,3}(?:`{3,}|~{3,}))[ \t]*openui[ \t\r]*$/;

export function fenceUiBlocks(text: string): string {
  if (!text.includes('openui')) return text;
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

  for (const line of text.split('\n')) {
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
      out.push(short ? `${short[1]}openui-lang` : line);
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
