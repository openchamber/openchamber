import { clearNode, el, ensureStyle, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'link'; href: string; label: string };

export type TextProps = {
  text: string;
  /** Called with the href of a clicked link. A sandboxed iframe cannot open it alone. */
  onOpenUrl?: (url: string) => void;
};

export type TextHandle = Handle<TextProps>;

const MARKDOWN_TOKEN = /(!?)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Splits text into plain runs, `![alt](https://…)` images, and `[label](https://…)` links. Anything else stays text. */
export const splitTextMedia = (text: string): TextPart[] => {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKDOWN_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({ kind: 'text', text: text.slice(last, index) });
    }
    const marker = match[1] ?? '';
    const label = (match[2] ?? '').trim();
    const href = match[3] ?? '';
    if (!isHttpUrl(href)) {
      parts.push({ kind: 'text', text: match[0] });
    } else if (marker === '!') {
      parts.push({ kind: 'image', src: href, alt: label });
    } else {
      parts.push({ kind: 'link', href, label: label || href });
    }
    last = index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ kind: 'text', text: text.slice(last) });
  }
  return parts;
};

export const mountText = (root: Element, initial: TextProps): TextHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const node = el('div', 'oc-sdk oc-sdk-text');
  root.append(node);

  const onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof HTMLAnchorElement) || !props.onOpenUrl) {
      return;
    }
    event.preventDefault();
    props.onOpenUrl(event.target.href);
  };

  const paint = (): void => {
    clearNode(node);
    for (const part of splitTextMedia(props.text)) {
      if (part.kind === 'text') {
        node.append(document.createTextNode(part.text));
      } else if (part.kind === 'link') {
        const link = el('a');
        link.href = part.href;
        link.rel = 'noopener noreferrer';
        link.target = '_blank';
        link.textContent = part.label;
        node.append(link);
      } else {
        const img = el('img');
        img.src = part.src;
        img.alt = part.alt;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        node.append(img);
      }
    }
  };
  node.addEventListener('click', onClick);
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      node.removeEventListener('click', onClick);
      node.remove();
    },
  };
};
