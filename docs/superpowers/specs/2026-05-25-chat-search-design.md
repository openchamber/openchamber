# Chat Search Design

**Date:** 2026-05-25  
**Status:** Approved

## Overview

Add a VS Code-style find widget to the chat view. Triggered by Cmd/Ctrl+F, it floats in the top-right corner of the chat viewport and lets the user search through message text with match navigation, case/whole-word/regex flags, and a scope toggle between user+assistant text and all content.

## Behavior

- **In-place highlighting.** All messages remain visible. Matching text is wrapped in `<mark>` elements. The active match has a distinct highlight color (orange). Other matches are dimly highlighted (yellow).
- **Navigation.** Up/down buttons and Enter/Shift+Enter cycle through matches in document order. The chat scrolls to keep the active match in view.
- **Scope toggle.** Default scope is "text" — searches user message text parts and assistant text/reasoning parts. "All" scope additionally searches tool call inputs and outputs.
- **Flags.** Case-sensitive (`Aa`), whole word (`ab`), regex (`.*`). All three are independent toggles.
- **Match count.** The widget shows "N of M" where N is the 1-based active index and M is the total number of matches found in the current DOM.
- **No replace.** Chat history is immutable; replace is not applicable.
- **Keyboard.** Cmd/Ctrl+F opens. Escape closes (when the search input is focused). Enter advances to the next match. Shift+Enter goes to the previous match.

## Architecture

### Zustand Store — `useChatSearchStore`

New file: `packages/ui/src/stores/useChatSearchStore.ts`

```typescript
interface SearchFlags {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

interface ChatSearchState {
  isOpen: boolean
  query: string
  flags: SearchFlags
  scope: 'text' | 'all'
  activeIndex: number    // 0-based index into the ordered DOM [data-search-match] elements
  totalMatches: number   // kept in sync by ChatSearchWidget after renders

  open: () => void
  // close() sets isOpen = false but preserves query and flags so reopening restores the previous search
  close: () => void
  setQuery: (q: string) => void
  setFlag: (flag: keyof SearchFlags, value: boolean) => void
  toggleScope: () => void
  // navigate wraps around: 'next' on the last match goes to index 0, 'prev' on index 0 goes to the last match
  navigate: (dir: 'prev' | 'next') => void
  setActiveIndex: (n: number) => void
  setTotalMatches: (n: number) => void
}
```

`activeIndex` and `totalMatches` are the only fields that change during navigation. No match record array is stored — matches live in the DOM as `<mark data-search-match>` elements, discovered imperatively by the widget.

### Widget Component — `ChatSearchWidget`

New file: `packages/ui/src/components/chat/ChatSearchWidget.tsx`

Absolutely positioned (`position: absolute; top: 0; right: 0; z-index: 50`) inside the `ChatViewport` wrapper, which is `position: relative`. Rendered only when `isOpen` is true.

Reads `{ isOpen, query, flags, scope, activeIndex, totalMatches }` from `useChatSearchStore`. Writes via store actions.

**Navigation effect:** A `useEffect` that fires when `activeIndex` changes:

1. Collects all `mark[data-search-match]` elements within `scrollRef.current` (the chat's scrollable container — passed as a prop from `ChatContainer`).
2. Updates `totalMatches` with the collected count.
3. Removes the `.active` class from the previously active mark.
4. Adds `.active` to the mark at `activeIndex`.
5. If the active mark's nearest ancestor with a `data-message-id` attribute is not rendered yet (virtualization gap), calls `messageListRef.current.scrollToMessageId(messageId)` first, then retries after a frame.
6. Calls `mark.scrollIntoView({ block: 'nearest', behavior: 'smooth' })`.

**Recount trigger:** A second `useEffect` depends on `[query, flags, scope]`. After a 350ms debounce it recounts `mark[data-search-match]` elements and resets `activeIndex` to 0. This runs after React has re-rendered the text components with new highlights.

**Input focus:** The search input is auto-focused when `isOpen` becomes true. `useEffect(() => { if (isOpen) inputRef.current?.focus() }, [isOpen])`.

**Escape handling:** `onKeyDown` on the input element: if `Escape`, call `close()` and stop propagation (to avoid triggering the global double-Escape abort). Clicking outside the widget does not auto-close it — the user must press Escape or click ×. This matches VS Code find widget behavior.

### Text Highlighting — Rehype Plugin

New file: `packages/ui/src/lib/rehypeMarkSearchMatches.ts`

A rehype plugin factory: `rehypeMarkSearchMatches(options: { query: string; caseSensitive: boolean; wholeWord: boolean; isRegex: boolean })`.

Behavior:
1. Builds a `RegExp` from the options. Returns a no-op plugin if `query` is empty or the regex is invalid.
2. Uses `unist-util-visit` to walk all `text` nodes in the HAST.
3. For each text node, finds all matches of the regex within the node's value.
4. Splits the text node into an array of alternating plain text nodes and `<mark data-search-match>` element nodes.
5. Replaces the original text node with the array.

Known limitation: matches that span across two inline markdown elements (e.g., a word split across `**bold**` and plain text) will not be highlighted. This is acceptable for a first implementation.

### Text Highlighting — Plain Text Splitter

New file: `packages/ui/src/lib/splitByHighlight.ts`

```typescript
// SearchFlags is the same interface defined in useChatSearchStore.ts (shared import)
function buildSearchRegex(query: string, flags: SearchFlags): RegExp | null

function splitByHighlight(
  text: string,
  regex: RegExp
): Array<{ text: string; isMatch: boolean }>
```

Used by `UserTextPart` in plain-text rendering mode to split the raw string into segments, rendering match segments as `<mark data-search-match>`.

### Integration into `AssistantTextPart`

`AssistantTextPart` reads `{ isOpen, query, flags }` from `useChatSearchStore` using a selector. It does **not** read `activeIndex` or `totalMatches` — so navigation never causes assistant message components to re-render.

When `isOpen && query`, it constructs a `searchContext: SearchContext` object and passes it to `MarkdownRenderer`:

```typescript
interface SearchContext {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  isRegex: boolean
}
```

The `searchContext` prop is added to `MarkdownRendererProps` in `MarkdownRendererImpl.tsx`. It is threaded through to `MarkdownBlockView`, which includes `rehypeMarkSearchMatches(searchContext)` in its `rehypePlugins` array when `searchContext` is provided.

`MarkdownBlockView`'s `React.memo` comparator is updated to include `searchContext` equality.

### Integration into `UserTextPart`

`UserTextPart` reads `{ isOpen, query, flags }` from `useChatSearchStore`.

- **Plain text mode:** applies `splitByHighlight` to the raw text content and renders match segments as `<mark data-search-match>`. Agent mention and skill token links are preserved by processing them in separate passes.
- **Markdown mode:** passes `searchContext` to `SimpleMarkdownRenderer` the same way as `AssistantTextPart`.

### Keyboard Shortcut

`packages/ui/src/lib/shortcuts.ts`: add to `SHORTCUT_ACTIONS`:

```typescript
{
  id: 'open_chat_search',
  defaultCombo: 'mod+f',
  label: 'Find in chat',
  description: 'Open the chat search widget',
  customizable: true,
}
```

`packages/ui/src/hooks/useKeyboardShortcuts.ts`: inside `handleKeyDown`, guard on `activeMainTab === 'chat'`:

```typescript
if (eventMatchesShortcut(e, combo('open_chat_search'))) {
  if (activeMainTab === 'chat') {
    e.preventDefault()
    useChatSearchStore.getState().open()
    return
  }
}
```

### CSS

In `packages/ui/src/lib/theme/` (or the global CSS entry):

```css
mark[data-search-match] {
  background: color-mix(in srgb, var(--color-warning) 25%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

mark[data-search-match].active {
  background: color-mix(in srgb, var(--color-warning) 65%, var(--color-accent) 35%);
}
```

All colors use theme tokens. No hardcoded hex values.

## Data Flow Summary

```
Cmd+F
  → useKeyboardShortcuts → useChatSearchStore.open()
  → ChatSearchWidget renders (isOpen = true, auto-focuses input)

User types query
  → useChatSearchStore.setQuery(q)
  → AssistantTextPart / UserTextPart re-render (read {isOpen, query, flags})
  → rehypeMarkSearchMatches injects <mark data-search-match> into markdown output
  → splitByHighlight injects <mark data-search-match> in plain text output
  → ChatSearchWidget recount effect fires (350ms debounce)
    → counts mark[data-search-match] in scrollRef
    → sets totalMatches, resets activeIndex to 0
    → scrolls first match into view, applies .active

User presses ↓ / Enter
  → useChatSearchStore.navigate('next') → activeIndex++
  → ChatSearchWidget navigation effect fires
    → swaps .active class
    → scrolls new active mark into view
```

## New Files

| File | Purpose |
|------|---------|
| `packages/ui/src/stores/useChatSearchStore.ts` | Search state (Zustand) |
| `packages/ui/src/components/chat/ChatSearchWidget.tsx` | Floating search bar UI |
| `packages/ui/src/lib/rehypeMarkSearchMatches.ts` | Rehype plugin for markdown highlighting |
| `packages/ui/src/lib/splitByHighlight.ts` | Plain-text match splitter |

## Modified Files

| File | Change |
|------|--------|
| `packages/ui/src/lib/shortcuts.ts` | Add `open_chat_search` action |
| `packages/ui/src/hooks/useKeyboardShortcuts.ts` | Handle `open_chat_search` shortcut |
| `packages/ui/src/components/chat/ChatContainer.tsx` | Render `<ChatSearchWidget>`, pass `scrollRef` and `messageListRef` |
| `packages/ui/src/components/chat/MarkdownRendererImpl.tsx` | Accept `searchContext` prop, pass to `MarkdownBlockView` |
| `packages/ui/src/components/chat/message/parts/AssistantTextPart.tsx` | Read search store, pass `searchContext` to `MarkdownRenderer` |
| `packages/ui/src/components/chat/message/parts/UserTextPart.tsx` | Read search store, apply `splitByHighlight` or pass `searchContext` |
| `packages/ui/src/lib/theme/` (CSS) | Add `mark[data-search-match]` styles |

## Performance Considerations

- **No match array in store.** Match positions are not stored in React state. Only `activeIndex` and `totalMatches` (two integers) change on navigation. Zero message component re-renders during prev/next.
- **Narrow store selector.** Text renderers subscribe to `{ isOpen, query, flags, scope }` only. Changes to `activeIndex` do not reach message components.
- **Streaming guard.** When a message is in streaming phase (`streamPhase === 'streaming'`), `AssistantTextPart` skips passing `searchContext` to avoid running the rehype plugin on every streaming tick. Highlights are applied once the message leaves the streaming phase.
- **Recount debounce.** The DOM recount is debounced 350ms after query/flag changes, giving React time to commit all the re-renders before counting marks.

## Open Questions / Future Work

- The scope toggle button label "T+A" is a placeholder. A better icon (e.g., a filter or layers icon from the existing SVG sprite) should be chosen during implementation.
- Matches spanning markdown inline element boundaries (e.g., a phrase split across `**bold** and plain`) are not highlighted. A future iteration could use a remark plugin operating on the source AST instead of rehype, which would catch more cross-element matches.
- When search is open and the session receives new streaming messages, the recount runs on a timer. A more precise trigger (MutationObserver on `scrollRef`) could be added if the delay is noticeable in practice.
