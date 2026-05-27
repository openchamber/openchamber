# Chat Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-style floating find widget (Cmd/Ctrl+F) to the chat view that highlights matches in message text and supports prev/next navigation, case/whole-word/regex flags, and a scope toggle.

**Architecture:** A narrow Zustand store holds `isOpen`, `query`, `flags`, `scope`, `activeIndex`, and `totalMatches`. Text renderers subscribe only to `{isOpen, query, flags, scope}` — navigation never re-renders message components. Matches live as `mark[data-search-match]` DOM elements; the widget manages `.active` class and scroll imperatively. Markdown highlighting uses a custom rehype plugin with a manual HAST tree walk (no new dependencies).

**Tech Stack:** React, TypeScript, Zustand, react-markdown rehype pipeline, Tailwind v4, theme CSS variables (`--status-warning`, `--status-warning-background`, `--status-warning-foreground`).

---

## File Map

**New files:**
- `packages/ui/src/stores/useChatSearchStore.ts` — Zustand store + exported `SearchFlags` / `SearchContext` types
- `packages/ui/src/lib/splitByHighlight.ts` — plain-text match splitter + `buildSearchRegex`
- `packages/ui/src/lib/splitByHighlight.test.ts` — unit tests
- `packages/ui/src/lib/rehypeMarkSearchMatches.ts` — rehype plugin (manual HAST tree walk)
- `packages/ui/src/lib/rehypeMarkSearchMatches.test.ts` — unit tests
- `packages/ui/src/components/chat/ChatSearchWidget.tsx` — floating search bar UI

**Modified files:**
- `packages/ui/src/lib/shortcuts.ts` — add `open_chat_search` action
- `packages/ui/src/hooks/useKeyboardShortcuts.ts` — handle `open_chat_search`
- `packages/ui/src/components/chat/MarkdownRendererImpl.tsx` — add `searchContext` prop, thread to `MarkdownBlockView`
- `packages/ui/src/components/chat/message/parts/AssistantTextPart.tsx` — read search store, pass `searchContext`
- `packages/ui/src/components/chat/message/parts/UserTextPart.tsx` — read search store, apply highlighting
- `packages/ui/src/components/chat/message/parts/ToolPart.tsx` — pass `searchContext` when scope is 'all' (tool input/output text)
- `packages/ui/src/components/chat/ChatContainer.tsx` — render `<ChatSearchWidget>`
- `packages/ui/src/index.css` — add `mark[data-search-match]` styles

---

## Task 1: Search Store

**Files:**
- Create: `packages/ui/src/stores/useChatSearchStore.ts`

- [ ] **Step 1: Write the store file**

```typescript
// packages/ui/src/stores/useChatSearchStore.ts
import { create } from 'zustand';

export interface SearchFlags {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchContext {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

interface ChatSearchState {
  isOpen: boolean;
  query: string;
  flags: SearchFlags;
  scope: 'text' | 'all';
  activeIndex: number;
  totalMatches: number;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  setFlag: (flag: keyof SearchFlags, value: boolean) => void;
  toggleScope: () => void;
  navigate: (dir: 'prev' | 'next') => void;
  setActiveIndex: (n: number) => void;
  setTotalMatches: (n: number) => void;
}

export const useChatSearchStore = create<ChatSearchState>((set, get) => ({
  isOpen: false,
  query: '',
  flags: { caseSensitive: false, wholeWord: false, regex: false },
  scope: 'text',
  activeIndex: 0,
  totalMatches: 0,

  open: () => set({ isOpen: true }),
  // close preserves query/flags so reopening restores the previous search
  close: () => set({ isOpen: false }),
  setQuery: (q) => set({ query: q }),
  setFlag: (flag, value) =>
    set((state) => ({ flags: { ...state.flags, [flag]: value } })),
  toggleScope: () =>
    set((state) => ({ scope: state.scope === 'text' ? 'all' : 'text' })),
  navigate: (dir) => {
    const { activeIndex, totalMatches } = get();
    if (totalMatches === 0) return;
    const next =
      dir === 'next'
        ? (activeIndex + 1) % totalMatches
        : (activeIndex - 1 + totalMatches) % totalMatches;
    set({ activeIndex: next });
  },
  setActiveIndex: (n) => set({ activeIndex: n }),
  setTotalMatches: (n) => set({ totalMatches: n }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/stores/useChatSearchStore.ts
git commit -m "feat(chat-search): add useChatSearchStore"
```

---

## Task 2: `splitByHighlight` Utility + Tests

**Files:**
- Create: `packages/ui/src/lib/splitByHighlight.ts`
- Create: `packages/ui/src/lib/splitByHighlight.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/ui/src/lib/splitByHighlight.test.ts
import { describe, it, expect } from 'bun:test';
import { buildSearchRegex, splitByHighlight } from './splitByHighlight';
import type { SearchFlags } from '@/stores/useChatSearchStore';

const plain: SearchFlags = { caseSensitive: false, wholeWord: false, regex: false };
const cs: SearchFlags = { caseSensitive: true, wholeWord: false, regex: false };
const ww: SearchFlags = { caseSensitive: false, wholeWord: true, regex: false };
const rx: SearchFlags = { caseSensitive: false, wholeWord: false, regex: true };

describe('buildSearchRegex', () => {
  it('returns null for empty query', () => {
    expect(buildSearchRegex('', plain)).toBeNull();
  });

  it('returns a case-insensitive regex by default', () => {
    const re = buildSearchRegex('foo', plain);
    expect(re).not.toBeNull();
    expect(re!.flags).toContain('i');
  });

  it('returns a case-sensitive regex when flag is set', () => {
    const re = buildSearchRegex('foo', cs);
    expect(re!.flags).not.toContain('i');
  });

  it('adds word boundaries for whole-word flag', () => {
    const re = buildSearchRegex('foo', ww);
    expect(re!.source).toContain('\\b');
  });

  it('treats query as literal when regex flag is off', () => {
    const re = buildSearchRegex('f.o', plain);
    // dot should be escaped
    expect(re!.source).toBe('f\\.o');
  });

  it('treats query as regex pattern when flag is on', () => {
    const re = buildSearchRegex('f.o', rx);
    // dot should NOT be escaped
    expect(re!.source).toBe('f.o');
  });

  it('returns null for invalid regex', () => {
    expect(buildSearchRegex('[unclosed', rx)).toBeNull();
  });
});

describe('splitByHighlight', () => {
  it('returns a single non-match segment when nothing matches', () => {
    const re = buildSearchRegex('xyz', plain)!;
    expect(splitByHighlight('hello world', re)).toEqual([
      { text: 'hello world', isMatch: false },
    ]);
  });

  it('splits a single match in the middle', () => {
    const re = buildSearchRegex('world', plain)!;
    expect(splitByHighlight('hello world!', re)).toEqual([
      { text: 'hello ', isMatch: false },
      { text: 'world', isMatch: true },
      { text: '!', isMatch: false },
    ]);
  });

  it('handles a match at the start', () => {
    const re = buildSearchRegex('hello', plain)!;
    expect(splitByHighlight('hello world', re)).toEqual([
      { text: 'hello', isMatch: true },
      { text: ' world', isMatch: false },
    ]);
  });

  it('handles a match at the end', () => {
    const re = buildSearchRegex('world', plain)!;
    expect(splitByHighlight('hello world', re)).toEqual([
      { text: 'hello ', isMatch: false },
      { text: 'world', isMatch: true },
    ]);
  });

  it('handles multiple matches', () => {
    const re = buildSearchRegex('o', plain)!;
    expect(splitByHighlight('foo', re)).toEqual([
      { text: 'f', isMatch: false },
      { text: 'o', isMatch: true },
      { text: 'o', isMatch: true },
    ]);
  });

  it('handles case-insensitive matching', () => {
    const re = buildSearchRegex('HELLO', plain)!;
    const result = splitByHighlight('hello world', re);
    expect(result[0]).toEqual({ text: 'hello', isMatch: true });
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd /path/to/worktree && /Users/ermanhavuc/.bun/bin/bun test packages/ui/src/lib/splitByHighlight.test.ts 2>&1
```

Expected: module not found / test failures.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/ui/src/lib/splitByHighlight.ts
import type { SearchFlags } from '@/stores/useChatSearchStore';

export function buildSearchRegex(query: string, flags: SearchFlags): RegExp | null {
  if (!query) return null;
  try {
    const escaped = flags.regex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const source = flags.wholeWord ? `\\b${escaped}\\b` : escaped;
    const regexFlags = flags.caseSensitive ? 'g' : 'gi';
    return new RegExp(source, regexFlags);
  } catch {
    return null;
  }
}

export function splitByHighlight(
  text: string,
  regex: RegExp,
): Array<{ text: string; isMatch: boolean }> {
  const result: Array<{ text: string; isMatch: boolean }> = [];
  let lastIndex = 0;
  // Clone the regex with the global flag to ensure correct exec behaviour.
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  re.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ text: text.slice(lastIndex, match.index), isMatch: false });
    }
    result.push({ text: match[0], isMatch: true });
    lastIndex = match.index + match[0].length;
    // Guard against infinite loop on zero-length matches.
    if (match[0].length === 0) re.lastIndex++;
  }

  if (lastIndex < text.length) {
    result.push({ text: text.slice(lastIndex), isMatch: false });
  }

  return result;
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
/Users/ermanhavuc/.bun/bin/bun test packages/ui/src/lib/splitByHighlight.test.ts 2>&1
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/splitByHighlight.ts packages/ui/src/lib/splitByHighlight.test.ts
git commit -m "feat(chat-search): add splitByHighlight utility"
```

---

## Task 3: `rehypeMarkSearchMatches` Plugin + Tests

**Files:**
- Create: `packages/ui/src/lib/rehypeMarkSearchMatches.ts`
- Create: `packages/ui/src/lib/rehypeMarkSearchMatches.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/ui/src/lib/rehypeMarkSearchMatches.test.ts
import { describe, it, expect } from 'bun:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import rehypeMarkSearchMatches from './rehypeMarkSearchMatches';

async function process(markdown: string, query: string, opts = {}) {
  const result = await unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeMarkSearchMatches, {
      query,
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      ...opts,
    })
    .use(rehypeStringify)
    .process(markdown);
  return String(result);
}

describe('rehypeMarkSearchMatches', () => {
  it('wraps a plain text match in <mark data-search-match>', async () => {
    const html = await process('hello world', 'world');
    expect(html).toContain('<mark data-search-match="">world</mark>');
    expect(html).toContain('hello ');
  });

  it('does nothing when query is empty', async () => {
    const html = await process('hello world', '');
    expect(html).not.toContain('<mark');
  });

  it('is case-insensitive by default', async () => {
    const html = await process('Hello World', 'hello');
    expect(html).toContain('<mark data-search-match="">Hello</mark>');
  });

  it('does not highlight inside <code> inline elements', async () => {
    const html = await process('Use `foo` here', 'foo');
    // foo inside backtick code should NOT be wrapped
    expect(html).not.toContain('<mark');
  });

  it('handles multiple matches in one paragraph', async () => {
    const html = await process('foo bar foo', 'foo');
    const markCount = (html.match(/<mark/g) || []).length;
    expect(markCount).toBe(2);
  });

  it('returns valid output for invalid regex', async () => {
    // should not throw, just produce no marks
    const html = await process('hello', '[unclosed', { isRegex: true });
    expect(html).not.toContain('<mark');
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
/Users/ermanhavuc/.bun/bin/bun test packages/ui/src/lib/rehypeMarkSearchMatches.test.ts 2>&1
```

Expected: module not found.

- [ ] **Step 3: Write the implementation**

No new dependencies — uses a manual HAST tree walk.

```typescript
// packages/ui/src/lib/rehypeMarkSearchMatches.ts
import type { Plugin } from 'unified';
import type { Root, Element, Text, RootContent, ElementContent } from 'hast';
import { buildSearchRegex } from './splitByHighlight';
import type { SearchFlags } from '@/stores/useChatSearchStore';

export interface RehypeMarkSearchMatchesOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

/**
 * Splits a HAST text node into an array of text nodes and <mark> elements
 * at match boundaries. Returns the original single-item array if no matches.
 */
function splitHastTextNode(
  node: Text,
  regex: RegExp,
): Array<Text | Element> {
  const text = node.value;
  const parts: Array<Text | Element> = [];
  let lastIndex = 0;

  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  re.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const mark: Element = {
      type: 'element',
      tagName: 'mark',
      properties: { 'data-search-match': true },
      children: [{ type: 'text', value: match[0] }],
    };
    parts.push(mark);
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex++;
  }

  if (parts.length === 0) return [node]; // no matches

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts;
}

/**
 * Returns true if the node is a <code> or <pre> element (skip highlighting inside these).
 */
function isCodeElement(node: { type: string; tagName?: string }): boolean {
  return node.type === 'element' && (node.tagName === 'code' || node.tagName === 'pre');
}

/**
 * Recursively transforms HAST node children, splitting text nodes at match
 * boundaries and inserting <mark> elements. Skips code/pre subtrees.
 */
function transformChildren(
  children: Array<RootContent | ElementContent>,
  regex: RegExp,
): Array<RootContent | ElementContent> {
  return children.flatMap((child) => {
    if (child.type === 'text') {
      return splitHastTextNode(child as Text, regex) as Array<RootContent | ElementContent>;
    }
    if (child.type === 'element') {
      if (isCodeElement(child as Element)) {
        return [child]; // do not highlight inside code blocks
      }
      const el = child as Element;
      return [{ ...el, children: transformChildren(el.children, regex) }] as Array<RootContent | ElementContent>;
    }
    return [child];
  });
}

const rehypeMarkSearchMatches: Plugin<[RehypeMarkSearchMatchesOptions], Root> = (options) => {
  return (tree) => {
    const flags: SearchFlags = {
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regex: options.isRegex,
    };
    const regex = buildSearchRegex(options.query, flags);
    if (!regex) return;

    tree.children = transformChildren(tree.children, regex) as Root['children'];
  };
};

export default rehypeMarkSearchMatches;
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
/Users/ermanhavuc/.bun/bin/bun test packages/ui/src/lib/rehypeMarkSearchMatches.test.ts 2>&1
```

Expected: all tests pass. If the remark/rehype packages needed for tests (`remark-parse`, `remark-rehype`, `rehype-stringify`, `unified`) are not resolvable, check `packages/ui/node_modules/` or root `node_modules/` — they are transitive deps of `react-markdown` already installed.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/rehypeMarkSearchMatches.ts packages/ui/src/lib/rehypeMarkSearchMatches.test.ts
git commit -m "feat(chat-search): add rehypeMarkSearchMatches plugin"
```

---

## Task 4: Thread `searchContext` Through `MarkdownRendererImpl`

**Files:**
- Modify: `packages/ui/src/components/chat/MarkdownRendererImpl.tsx`

The relevant sections are:
- Line 1017: `MarkdownBlockView` component definition
- Line 1026: its `React.memo` comparator
- Line 1030: `MarkdownRendererProps` interface
- Line 1732: where `MarkdownBlockView` is called in the render

- [ ] **Step 1: Add `SearchContext` import and extend `MarkdownRendererProps`**

Find the `MarkdownRendererProps` interface (around line 1030) and add the optional prop:

```typescript
// Add import near the top of the file, alongside other imports
import type { SearchContext } from '@/stores/useChatSearchStore';

// In the MarkdownRendererProps interface (around line 1030), add:
interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
  searchContext?: SearchContext; // <-- ADD THIS
}
```

- [ ] **Step 2: Extend `MarkdownBlockView` to accept and use `searchContext`**

Replace the existing `MarkdownBlockView` definition (around lines 1017-1028) with:

```typescript
import rehypeMarkSearchMatches from '@/lib/rehypeMarkSearchMatches';

const MarkdownBlockView: React.FC<{
  block: MarkdownStreamBlock;
  components: Components;
  searchContext?: SearchContext;
}> = React.memo(({ block, components, searchContext }) => {
  const rehypePlugins: ReactMarkdownOptions['rehypePlugins'] = [
    [rehypeKatex, { throwOnError: false, errorColor: 'var(--destructive)' }],
  ];
  if (searchContext && searchContext.query) {
    rehypePlugins.push([
      rehypeMarkSearchMatches,
      {
        query: searchContext.query,
        caseSensitive: searchContext.caseSensitive,
        wholeWord: searchContext.wholeWord,
        isRegex: searchContext.isRegex,
      },
    ]);
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {block.src}
    </ReactMarkdown>
  );
}, (prev, next) =>
  prev.block === next.block &&
  prev.components === next.components &&
  prev.searchContext?.query === next.searchContext?.query &&
  prev.searchContext?.caseSensitive === next.searchContext?.caseSensitive &&
  prev.searchContext?.wholeWord === next.searchContext?.wholeWord &&
  prev.searchContext?.isRegex === next.searchContext?.isRegex,
);

MarkdownBlockView.displayName = 'MarkdownBlockView';
```

You will need to add the `ReactMarkdownOptions` type import. Find the existing `react-markdown` import and check if `Options` is exported:

```typescript
import ReactMarkdown, { type Options as ReactMarkdownOptions } from 'react-markdown';
```

- [ ] **Step 3: Thread `searchContext` into `MarkdownBlockView` at the render site**

Find the `markdownContent` block (around line 1729) and pass `searchContext`:

```typescript
const markdownContent = (
  <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
    <div className={markdownClassName}>
      {markdownBlocks.map((block) => (
        <MarkdownBlockView
          key={block.key}
          block={block}
          components={markdownComponents}
          searchContext={searchContext}
        />
      ))}
    </div>
  </div>
);
```

`searchContext` is the new prop coming from `MarkdownRendererProps` — it flows through from the component's props destructuring. Add it to the destructured props list at the top of the `MarkdownRenderer` function body.

- [ ] **Step 4: Type-check this file in isolation**

```bash
cd /Users/ermanhavuc/.local/share/opencode/worktree/4b2edf73188e5dc63cc6a1deb71c4c5eb0f87de2/gentle-zebra && /Users/ermanhavuc/.bun/bin/bun run type-check 2>&1 | head -40
```

Fix any type errors before continuing.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/chat/MarkdownRendererImpl.tsx
git commit -m "feat(chat-search): thread searchContext through MarkdownRendererImpl"
```

---

## Task 5: `AssistantTextPart` Integration

**Files:**
- Modify: `packages/ui/src/components/chat/message/parts/AssistantTextPart.tsx`

- [ ] **Step 1: Add search store selector and pass `searchContext` to `MarkdownRenderer`**

Add the store import near the top:

```typescript
import { useChatSearchStore } from '@/stores/useChatSearchStore';
import type { SearchContext } from '@/stores/useChatSearchStore';
```

Inside the `AssistantTextPart` component function body, add the selector **after** the existing hooks. Read only `{isOpen, query, flags}` — NOT `activeIndex` or `totalMatches`:

```typescript
const searchIsOpen = useChatSearchStore((s) => s.isOpen);
const searchQuery = useChatSearchStore((s) => s.query);
const searchFlags = useChatSearchStore((s) => s.flags);
```

Then construct `searchContext` conditionally. Skip it during streaming to avoid running the rehype plugin on every streaming tick:

```typescript
const searchContext: SearchContext | undefined =
  searchIsOpen && searchQuery && !isStreaming
    ? {
        query: searchQuery,
        caseSensitive: searchFlags.caseSensitive,
        wholeWord: searchFlags.wholeWord,
        isRegex: searchFlags.regex,
      }
    : undefined;
```

Pass it to `MarkdownRenderer` in the return JSX:

```tsx
<MarkdownRenderer
  content={displayTextContent}
  part={part}
  messageId={messageId}
  isAnimated={false}
  isStreaming={isStreaming}
  disableStreamAnimation={chatRenderMode === 'sorted'}
  variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
  enableFileReferences={isFinalized}
  searchContext={searchContext}
/>
```

- [ ] **Step 2: Type-check**

```bash
/Users/ermanhavuc/.bun/bin/bun run type-check 2>&1 | head -40
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/chat/message/parts/AssistantTextPart.tsx
git commit -m "feat(chat-search): integrate search highlighting in AssistantTextPart"
```

---

## Task 6: `UserTextPart` Integration

**Files:**
- Modify: `packages/ui/src/components/chat/message/parts/UserTextPart.tsx`

- [ ] **Step 1: Add store import and build `searchContext`**

Add imports near top:

```typescript
import { useChatSearchStore } from '@/stores/useChatSearchStore';
import type { SearchContext } from '@/stores/useChatSearchStore';
import { buildSearchRegex, splitByHighlight } from '@/lib/splitByHighlight';
```

Inside the `UserTextPart` component body, add after existing hooks:

```typescript
const searchIsOpen = useChatSearchStore((s) => s.isOpen);
const searchQuery = useChatSearchStore((s) => s.query);
const searchFlags = useChatSearchStore((s) => s.flags);

const searchContext: SearchContext | undefined =
  searchIsOpen && searchQuery
    ? {
        query: searchQuery,
        caseSensitive: searchFlags.caseSensitive,
        wholeWord: searchFlags.wholeWord,
        isRegex: searchFlags.regex,
      }
    : undefined;
```

- [ ] **Step 2: Apply highlighting in plain text mode**

`UserTextPart` currently renders `plainTextContent` (a `React.ReactNode[]`) in plain mode. Add a helper inside the component to split string segments by match:

```typescript
const highlightNodes = React.useMemo(() => {
  if (!searchContext) return plainTextContent;
  const regex = buildSearchRegex(searchContext.query, {
    caseSensitive: searchContext.caseSensitive,
    wholeWord: searchContext.wholeWord,
    regex: searchContext.isRegex,
  });
  if (!regex) return plainTextContent;

  return plainTextContent.flatMap((node, i) => {
    if (typeof node !== 'string') return [node];
    const parts = splitByHighlight(node, regex);
    return parts.map((part, j) =>
      part.isMatch ? (
        <mark key={`hl-${i}-${j}`} data-search-match>
          {part.text}
        </mark>
      ) : (
        part.text
      ),
    );
  });
}, [plainTextContent, searchContext]);
```

In the JSX render, replace `plainTextContent` with `highlightNodes` in plain mode:

```tsx
{normalizedRenderingMode === 'markdown' ? (
  <SimpleMarkdownRenderer
    content={processedMarkdownContent}
    className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
    disableLinkSafety
    searchContext={searchContext}
  />
) : (
  highlightNodes
)}
```

- [ ] **Step 3: Type-check**

```bash
/Users/ermanhavuc/.bun/bin/bun run type-check 2>&1 | head -40
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/chat/message/parts/UserTextPart.tsx
git commit -m "feat(chat-search): integrate search highlighting in UserTextPart"
```

---

## Task 6.5: `ToolPart` Integration (scope 'all')

**Files:**
- Modify: `packages/ui/src/components/chat/message/parts/ToolPart.tsx`

When `scope === 'all'` and search is open, highlight tool input text (`inputTextContent`) and `task` tool output (via `SimpleMarkdownRenderer`). `SyntaxHighlighter` and `JsonTreeViewer` outputs are **not** highlighted — this is accepted scope for this implementation.

- [ ] **Step 1: Add store imports**

```typescript
import { useChatSearchStore } from '@/stores/useChatSearchStore';
import type { SearchContext } from '@/stores/useChatSearchStore';
import { buildSearchRegex, splitByHighlight } from '@/lib/splitByHighlight';
```

- [ ] **Step 2: Build `searchContext` inside the `ToolPart` component**

After the existing hooks in the `ToolPart` function body:

```typescript
const searchIsOpen = useChatSearchStore((s) => s.isOpen);
const searchQuery = useChatSearchStore((s) => s.query);
const searchFlags = useChatSearchStore((s) => s.flags);
const searchScope = useChatSearchStore((s) => s.scope);

const toolSearchContext: SearchContext | undefined =
  searchIsOpen && searchQuery && searchScope === 'all'
    ? {
        query: searchQuery,
        caseSensitive: searchFlags.caseSensitive,
        wholeWord: searchFlags.wholeWord,
        isRegex: searchFlags.regex,
      }
    : undefined;

const toolSearchRegex = React.useMemo(
  () =>
    toolSearchContext
      ? buildSearchRegex(toolSearchContext.query, {
          caseSensitive: toolSearchContext.caseSensitive,
          wholeWord: toolSearchContext.wholeWord,
          regex: toolSearchContext.isRegex,
        })
      : null,
  [toolSearchContext],
);
```

- [ ] **Step 3: Highlight tool input text**

The input is rendered in two places (inside `<pre>` for bash and `<blockquote>` for others). In both cases, replace the `{inputTextContent}` JSX expression with a helper that splits it by matches:

```typescript
// Helper defined inside ToolPart:
const highlightedInput = React.useMemo(() => {
  if (!toolSearchRegex || !inputTextContent) return inputTextContent;
  const parts = splitByHighlight(inputTextContent, toolSearchRegex);
  return parts.map((p, i) =>
    p.isMatch ? (
      <mark key={i} data-search-match>
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
}, [inputTextContent, toolSearchRegex]);
```

In the input rendering section (around lines 1818-1829), replace `{inputTextContent}` with `{highlightedInput}` in both the `<pre>` and `<blockquote>` branches.

- [ ] **Step 4: Pass `searchContext` to `SimpleMarkdownRenderer` for `task` tool output**

Find the section around line 1737:

```typescript
if (part.tool === 'task' && hasStringOutput) {
  return renderScrollableBlock(
    <div className="w-full min-w-0">
      <SimpleMarkdownRenderer
        content={outputString}
        variant="tool"
        onShowPopup={onShowPopup}
        searchContext={toolSearchContext}
      />
    </div>
  );
}
```

- [ ] **Step 5: Type-check**

```bash
/Users/ermanhavuc/.bun/bin/bun run type-check 2>&1 | head -40
```

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/chat/message/parts/ToolPart.tsx
git commit -m "feat(chat-search): highlight tool input and task output in all-scope mode"
```

---

## Task 7: CSS Mark Styles

**Files:**
- Modify: `packages/ui/src/index.css`

- [ ] **Step 1: Add mark highlight styles**

Open `packages/ui/src/index.css` and append the following before the final line:

```css
/* ── Chat search highlight ─────────────────────────────────────────────── */
mark[data-search-match] {
  background-color: var(--status-warning-background);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

mark[data-search-match].active {
  background-color: var(--status-warning);
  color: var(--status-warning-foreground);
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/index.css
git commit -m "feat(chat-search): add mark highlight CSS"
```

---

## Task 8: `ChatSearchWidget` Component

**Files:**
- Create: `packages/ui/src/components/chat/ChatSearchWidget.tsx`

The widget is positioned absolute, top-right of the chat viewport. It reads state from `useChatSearchStore`, manages `activeIndex`/`totalMatches` by querying the DOM after renders, and handles navigation by swapping the `.active` CSS class on `<mark>` elements.

- [ ] **Step 1: Write the component**

```tsx
// packages/ui/src/components/chat/ChatSearchWidget.tsx
import React from 'react';
import { useChatSearchStore } from '@/stores/useChatSearchStore';
import { Icon } from '@/components/icon/Icon';
import type { MessageListHandle } from './MessageList';

interface ChatSearchWidgetProps {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messageListRef: React.RefObject<MessageListHandle | null>;
}

export const ChatSearchWidget: React.FC<ChatSearchWidgetProps> = ({
  scrollRef,
  messageListRef,
}) => {
  const isOpen = useChatSearchStore((s) => s.isOpen);
  const query = useChatSearchStore((s) => s.query);
  const flags = useChatSearchStore((s) => s.flags);
  const scope = useChatSearchStore((s) => s.scope);
  const activeIndex = useChatSearchStore((s) => s.activeIndex);
  const totalMatches = useChatSearchStore((s) => s.totalMatches);
  const { close, setQuery, setFlag, toggleScope, navigate, setActiveIndex, setTotalMatches } =
    useChatSearchStore.getState();

  const inputRef = React.useRef<HTMLInputElement>(null);

  // Auto-focus input when widget opens.
  React.useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Single helper that clears all .active marks, applies .active to `index`,
  // and scrolls it into view. Used by both the recount and navigation effects.
  const applyActiveMark = React.useCallback(
    (index: number) => {
      const container = scrollRef.current;
      if (!container) return;
      const marks = Array.from(
        container.querySelectorAll<HTMLElement>('mark[data-search-match]'),
      );
      marks.forEach((m) => m.classList.remove('active'));
      if (marks.length === 0) return;
      const clamped = Math.max(0, Math.min(index, marks.length - 1));
      const target = marks[clamped];
      target.classList.add('active');
      const messageAncestor = target.closest<HTMLElement>('[data-message-id]');
      const messageId = messageAncestor?.dataset.messageId;
      if (messageId && messageListRef.current) {
        messageListRef.current.scrollToMessageId(messageId, { behavior: 'smooth' });
        requestAnimationFrame(() => {
          target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      } else {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    },
    [scrollRef, messageListRef],
  );

  // Recount marks and activate first match when query/flags/scope change.
  // Debounced 350ms to let React re-render text components with new marks first.
  React.useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      const container = scrollRef.current;
      if (!container) return;
      const marks = Array.from(
        container.querySelectorAll<HTMLElement>('mark[data-search-match]'),
      );
      setTotalMatches(marks.length);
      setActiveIndex(0);
      // Always apply directly here — setActiveIndex(0) does not fire the
      // navigation effect below when activeIndex was already 0.
      applyActiveMark(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [query, flags.caseSensitive, flags.wholeWord, flags.regex, scope, isOpen, scrollRef, setTotalMatches, setActiveIndex, applyActiveMark]);

  // Activate correct mark when user navigates (prev / next).
  React.useEffect(() => {
    if (!isOpen) return;
    applyActiveMark(activeIndex);
  }, [activeIndex, isOpen, applyActiveMark]);

  // Clean up .active marks when widget closes.
  React.useEffect(() => {
    if (!isOpen) {
      const container = scrollRef.current;
      if (!container) return;
      container
        .querySelectorAll<HTMLElement>('mark[data-search-match].active')
        .forEach((el) => el.classList.remove('active'));
    }
  }, [isOpen, scrollRef]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // prevent global double-ESC abort handler
      close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(e.shiftKey ? 'prev' : 'next');
    }
  };

  const flagButtonClass = (active: boolean) =>
    `h-6 px-1.5 rounded text-xs font-mono border transition-colors cursor-pointer select-none ${
      active
        ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)] border-[var(--interactive-selection)]'
        : 'bg-transparent text-[var(--surface-mutedForeground)] border-[var(--interactive-border)] hover:bg-[var(--interactive-hover)]'
    }`;

  const countLabel =
    totalMatches === 0
      ? query
        ? 'No results'
        : ''
      : `${activeIndex + 1} of ${totalMatches}`;

  return (
    <div
      className="absolute top-2 right-3 z-50 flex items-center gap-1 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5 shadow-lg"
      style={{ minWidth: 280 }}
    >
      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in chat"
        className="h-6 flex-1 min-w-0 bg-transparent text-xs text-[var(--surface-foreground)] placeholder:text-[var(--surface-mutedForeground)] outline-none"
        style={
          totalMatches === 0 && query
            ? { color: 'var(--status-error)' }
            : undefined
        }
        aria-label="Search chat"
      />

      {/* Flag toggles */}
      <button
        type="button"
        title="Case sensitive (Alt+C)"
        className={flagButtonClass(flags.caseSensitive)}
        onClick={() => setFlag('caseSensitive', !flags.caseSensitive)}
        aria-pressed={flags.caseSensitive}
      >
        Aa
      </button>
      <button
        type="button"
        title="Whole word (Alt+W)"
        className={flagButtonClass(flags.wholeWord)}
        onClick={() => setFlag('wholeWord', !flags.wholeWord)}
        aria-pressed={flags.wholeWord}
        style={{ textDecoration: 'underline' }}
      >
        ab
      </button>
      <button
        type="button"
        title="Use regular expression (Alt+R)"
        className={flagButtonClass(flags.regex)}
        onClick={() => setFlag('regex', !flags.regex)}
        aria-pressed={flags.regex}
      >
        .*
      </button>

      {/* Scope toggle */}
      <button
        type="button"
        title={scope === 'text' ? 'Searching user + assistant text. Click to search all content.' : 'Searching all content. Click to search text only.'}
        className={flagButtonClass(scope === 'all')}
        onClick={toggleScope}
        aria-pressed={scope === 'all'}
      >
        {scope === 'text' ? 'T' : 'All'}
      </button>

      {/* Divider */}
      <span className="h-4 w-px bg-[var(--interactive-border)] mx-0.5" aria-hidden />

      {/* Match count */}
      <span
        className="text-xs tabular-nums min-w-[48px] text-center text-[var(--surface-mutedForeground)] shrink-0"
        aria-live="polite"
      >
        {countLabel}
      </span>

      {/* Prev / Next */}
      <button
        type="button"
        title="Previous match (Shift+Enter)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] text-[var(--surface-mutedForeground)] disabled:opacity-40"
        onClick={() => navigate('prev')}
        disabled={totalMatches === 0}
        aria-label="Previous match"
      >
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Next match (Enter)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] text-[var(--surface-mutedForeground)] disabled:opacity-40"
        onClick={() => navigate('next')}
        disabled={totalMatches === 0}
        aria-label="Next match"
      >
        <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
      </button>

      {/* Close */}
      <button
        type="button"
        title="Close (Escape)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] text-[var(--surface-mutedForeground)]"
        onClick={close}
        aria-label="Close search"
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

export default ChatSearchWidget;
```

- [ ] **Step 2: Type-check**

```bash
/Users/ermanhavuc/.bun/bin/bun run type-check 2>&1 | head -40
```

Fix any missing icon names by running `bun run icons:generate` after adding the names used (`arrow-up-s`, `arrow-down-s`, `close`). These likely already exist in the sprite. Verify:

```bash
/Users/ermanhavuc/.bun/bin/bun run type-check 2>&1 | grep -i "ChatSearchWidget"
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/chat/ChatSearchWidget.tsx
git commit -m "feat(chat-search): add ChatSearchWidget component"
```

---

## Task 9: Keyboard Shortcut

**Files:**
- Modify: `packages/ui/src/lib/shortcuts.ts`
- Modify: `packages/ui/src/hooks/useKeyboardShortcuts.ts`

- [ ] **Step 1: Add shortcut action to `shortcuts.ts`**

Open `packages/ui/src/lib/shortcuts.ts`. Find the `SHORTCUT_ACTIONS` array (starts around line 106) and append the new entry before the closing `]`:

```typescript
{
  id: 'open_chat_search',
  defaultCombo: 'mod+f',
  label: 'Find in chat',
  description: 'Open the chat search widget',
  customizable: true,
},
```

- [ ] **Step 2: Handle the shortcut in `useKeyboardShortcuts.ts`**

Open `packages/ui/src/hooks/useKeyboardShortcuts.ts`. Add the import for `useChatSearchStore` near the top:

```typescript
import { useChatSearchStore } from '@/stores/useChatSearchStore';
```

Find the `handleKeyDown` function (around line 100). After the existing shortcut blocks (e.g., after the `open_command_palette` block), add:

```typescript
if (eventMatchesShortcut(e, combo('open_chat_search'))) {
  if (activeMainTab === 'chat') {
    e.preventDefault();
    useChatSearchStore.getState().open();
    return;
  }
}
```

`activeMainTab` is already in scope — it is destructured from `useUIStore` at the top of the `useEffect` that contains `handleKeyDown`. Verify it is in the destructured list; if not, add it.

- [ ] **Step 3: Type-check**

```bash
/Users/ermanhavuc/.bun/bin/bun run type-check 2>&1 | head -40
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/shortcuts.ts packages/ui/src/hooks/useKeyboardShortcuts.ts
git commit -m "feat(chat-search): add Cmd+F keyboard shortcut to open chat search"
```

---

## Task 10: Wire Widget into `ChatContainer`

**Files:**
- Modify: `packages/ui/src/components/chat/ChatContainer.tsx`

- [ ] **Step 1: Add import for `ChatSearchWidget`**

Near the top of `ChatContainer.tsx`, after the existing component imports:

```typescript
import { ChatSearchWidget } from './ChatSearchWidget';
```

- [ ] **Step 2: Render `ChatSearchWidget` inside the outer `<div>`**

The outer `return` in `ChatContainer` (around line 884) looks like:

```tsx
return (
  <div className="relative flex flex-col h-full bg-background">
    {returnToParentButton}
    <ChatViewport ... />
    <div className={cn('relative z-10', ...)}>
      ...
    </div>
    <TimelineDialog ... />
  </div>
);
```

Add `<ChatSearchWidget>` after `{returnToParentButton}`:

```tsx
return (
  <div className="relative flex flex-col h-full bg-background">
    {returnToParentButton}
    <ChatSearchWidget scrollRef={scrollRef} messageListRef={messageListRef} />
    <ChatViewport ... />
    <div className={cn('relative z-10', ...)}>
      ...
    </div>
    <TimelineDialog ... />
  </div>
);
```

The outer `<div>` already has `position: relative` (from `relative` Tailwind class), so `position: absolute` on the widget will be anchored to it.

- [ ] **Step 3: Ensure `data-message-id` is set on message DOM nodes**

`ChatSearchWidget` reads `target.closest('[data-message-id]')` to find which message contains the active mark. Check that `ChatMessage.tsx` (or `TurnItem.tsx`) sets `data-message-id` on its outer element. Grep for it:

```bash
cd /Users/ermanhavuc/.local/share/opencode/worktree/4b2edf73188e5dc63cc6a1deb71c4c5eb0f87de2/gentle-zebra && grep -r "data-message-id" packages/ui/src/components/chat/ 2>&1 | head -20
```

If it does **not** exist, add `data-message-id={messageId}` to the outermost `<div>` in `ChatMessage.tsx`. The `messageId` prop is already available there (it's a required prop). If it already exists, no change needed.

- [ ] **Step 4: Type-check and lint**

```bash
/Users/ermanhavuc/.bun/bin/bun run type-check 2>&1
/Users/ermanhavuc/.bun/bin/bun run lint 2>&1 | head -60
```

Fix any errors before committing.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/chat/ChatContainer.tsx
# include ChatMessage.tsx if data-message-id was added
git commit -m "feat(chat-search): wire ChatSearchWidget into ChatContainer"
```

---

## Task 11: Final Verification

- [ ] **Step 1: Full type-check**

```bash
/Users/ermanhavuc/.bun/bin/bun run type-check 2>&1
```

Expected: zero errors.

- [ ] **Step 2: Lint**

```bash
/Users/ermanhavuc/.bun/bin/bun run lint 2>&1
```

Expected: zero errors or warnings.

- [ ] **Step 3: Run all new tests**

```bash
/Users/ermanhavuc/.bun/bin/bun test packages/ui/src/lib/splitByHighlight.test.ts packages/ui/src/lib/rehypeMarkSearchMatches.test.ts 2>&1
```

Expected: all tests pass.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(chat-search): final verification pass"
```
