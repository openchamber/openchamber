# Reproduction: Issue #2047 - Syntax code highlight doesn't work

## Summary

The user reports that syntax highlighting in code blocks appears as "full gray
text block" in the VS Code extension at version 1.14.0.

## Analysis

The syntax highlighting pipeline involves these steps:

1. **Markdown parsing** (`marked`) produces `<pre><code class="language-*">`
2. **Shiki Web Worker** tokenizes the code and produces `<span>` elements with
   `color:var(--md-syntax-*)` CSS variable references
3. **CSS variables** `--md-syntax-*` are set as inline styles on the markdown
   container from the current theme's `syntax.base.*` colors
4. **Browser** resolves `var(--md-syntax-*)` to concrete colors

### Failure Mode: "full gray text block"

If ALL syntax text appears in the same gray color, it means either:

**A. The Shiki worker is not producing highlighted output**
   - Worker creation fails in VS Code webview (URL resolution, CSP)
   - `highlightCodeInWorker()` returns `null`, falls back to plain `<pre><code>`
   - The code renders as plain (gray) text with no syntax spans

**B. The `--md-syntax-*` CSS variables are not defined on the container**
   - `getMarkdownSyntaxVars()` produces variables like
     `'--md-syntax-keyword': '#569cd6'`
   - These are applied via `target.style.setProperty(key, value)` in a `useEffect`
   - If the target element doesn't exist yet, or the effect doesn't run,
     the CSS variables are not set
   - Shiki's `<span style="color:var(--md-syntax-keyword)">` can't resolve
     the variable, and the browser falls back to the inherited gray color

**C. The VS Code terminal ANSI colors are all similar grays**
   - The VS Code adapter maps syntax tokens to terminal ANSI colors
   - If a VS Code theme doesn't set distinct terminal colors, all tokens
     would appear similar

## Reproduction Steps

1. Install VS Code extension v1.14.0
2. Open any workspace with a TypeScript/JavaScript project
3. In a chat session, ask for code that includes code blocks
4. Observe that code blocks show all text as gray (no syntax coloring)

## Root Cause (Suspected)

The Shiki worker creation via `new Worker(MarkdownShikiWorkerUrl, { type: 'module' })`
in `packages/ui/src/components/chat/markdown/markdown-worker.ts` depends on the
Vite-resolved worker URL. In the VS Code webview, this URL is a relative path
like `./assets/markdown-shiki-worker-[hash].js` resolved against the webview's
`vscode-resource://` base URI. If the worker chunk is not accessible via
`localResourceRoots` or if the CSP blocks module workers, the worker silently
fails and highlighting falls back to plain text.

Additionally, there is a timing/ordering concern: the `--md-syntax-*` CSS
variables are applied in `useEffect` after the morphdom effect. If the markdown
container (`[data-markdown-content]`) is replaced during morphdom, the variables
may not be set on the right element.

## Files Involved

| File | Role |
|---|---|
| `packages/ui/src/components/chat/markdown/markdown-worker.ts` | Creates Shiki worker |
| `packages/ui/src/components/chat/markdown/markdown-shiki.worker.ts` | Shiki worker implementation |
| `packages/ui/src/components/chat/markdown/markdownShikiThemeDefinition.ts` | CSS-variable-based theme |
| `packages/ui/src/components/chat/markdown/markdownTheme.ts` | `getMarkdownSyntaxVars()` |
| `packages/ui/src/components/chat/MarkdownRendererImpl.tsx` | Applies syntax vars (line 1101-1109) |
| `packages/ui/src/lib/theme/vscode/adapter.ts` | VS Code theme adaptation |
| `packages/vscode/webview/main.tsx` | VS Code webview entry, emits theme |
| `packages/ui/src/index.css` | Code block CSS (line 1151-1218) |
