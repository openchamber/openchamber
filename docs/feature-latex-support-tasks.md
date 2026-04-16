# Feature LaTeX Support — Task List

## Branch Setup
1. [ ] Create branch `feature/latex-support` from `main`

## 1. Dependencies
2. [ ] Add `katex@^0.16.21` to `packages/ui/package.json` dependencies
3. [ ] Add `remark-math@^6.0.0` to `packages/ui/package.json` dependencies
4. [ ] Add `rehype-katex@^7.0.1` to `packages/ui/package.json` dependencies
5. [ ] Run `bun install` to update `bun.lock`

## 2. CSS Integration
6. [ ] Add `@import "katex/dist/katex.min.css";` to `packages/ui/src/index.css`
7. [ ] Add KaTeX light/dark theme color overrides in `packages/ui/src/index.css`:
   - `.katex { color: var(--foreground); }`
   - `.katex .mord`, `.katex .mbin`, etc. inherit foreground
   - `.katex-error` color: `var(--destructive)` (or equivalent)

## 3. MarkdownRenderer Integration
8. [ ] Add `import remarkMath from 'remark-math';` to `MarkdownRenderer.tsx`
9. [ ] Add `import rehypeKatex from 'rehype-katex';` to `MarkdownRenderer.tsx`
10. [ ] Update `MarkdownBlockView` at line 820 to include plugins:
    ```tsx
    <ReactMarkdown 
      remarkPlugins={[remarkGfm, remarkMath]} 
      rehypePlugins={[rehypeKatex]} 
      components={components}
    >
    ```

## 4. TypeScript Types
11. [ ] Verify `@types/katex` is not needed (bundled with `katex`)
12. [ ] Run `bun run type-check` — resolve any type errors

## 5. Lint
13. [ ] Run `bun run lint` — fix any lint errors

## 6. Functional Testing

### Inline Math
14. [ ] Test: `$x^2 + y^2 = z^2$` → renders as inline formula
15. [ ] Test: `\(`inline with parens`\)` → renders as inline formula

### Display Math
16. [ ] Test: `$$\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$` → centered block
17. [ ] Test: `\[display with brackets\]` → centered block

### Complex Expressions
18. [ ] Test: Matrix `$$\begin{pmatrix} a & b \\ c & d \end{pmatrix}$$`
19. [ ] Test: Fraction `$$\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$`
20. [ ] Test: Summation `$$\sum_{i=1}^n i = \frac{n(n+1)}{2}$$`

### Edge Cases
21. [ ] Test: `\$5.00` → dollar sign escaped, not rendered as math
22. [ ] Test: Math inside table cell renders correctly
23. [ ] Test: Math inside list item `1. Solve $x^2 = 4$` renders correctly
24. [ ] Test: Code block adjacent to math — both render independently
25. [ ] Test: Invalid LaTeX shows KaTeX error message, not crash

### Theme & Visual
26. [ ] Test: Light mode — KaTeX text color matches surrounding text
27. [ ] Test: Dark mode — KaTeX text color matches surrounding text
28. [ ] Test: Long inline math wraps at container boundary
29. [ ] Test: Tall display math doesn't overflow card/container

### Scope Coverage
30. [ ] Test: Assistant message with math renders
31. [ ] Test: User message (markdown mode) with math renders
32. [ ] Test: Tool output with math renders
33. [ ] Test: PR description with math renders
34. [ ] Test: File view (README.md) with math renders

## 7. Regression Testing
35. [ ] Existing markdown (headings, lists, tables, code blocks) still works
36. [ ] Mermaid diagrams still render (existing feature)
37. [ ] Syntax highlighting still works
38. [ ] File links still work

## 8. Build & Release
39. [ ] Run `bun run build` — successful build
40. [ ] Test desktop runtime (if applicable)
41. [ ] Test VS Code runtime (if applicable)

## 9. Pull Request
42. [ ] Commit: `feat: implement LaTeX math rendering via KaTeX`
43. [ ] Push `feature/latex-support` to remote
44. [ ] Create PR with description (use PR template from plan)
45. [ ] Add `Closes #<issue-number>` if an issue exists
46. [ ] Request review from maintainer

## 10. Post-Merge (Maintainer)
47. [ ] Verify CI passes
48. [ ] Verify LaTeX renders in production deployment
