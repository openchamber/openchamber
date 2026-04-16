# Plan: LaTeX Math Rendering via KaTeX

## Status
**Proposed** | **Branch:** `feature/latex-support`

## Summary
Integrate KaTeX to automatically render LaTeX math expressions (inline `$...$` and display `$$...$$`) in all OpenChamber markdown rendering contexts.

## Motivation

### Problem
Currently, mathematical expressions appear as raw plain text (e.g., `$E=mc^2$`), limiting OpenChamber's utility for technical, scientific, and academic users.

### Opportunity
- Researchers and engineers frequently need to share equations
- Competitor platforms lack native math rendering, making this a differentiator
- Enhances perceived professionalism and correctness

## Technical Justification

### Why KaTeX over MathJax
| Criterion | KaTeX | MathJax 3 |
|-----------|-------|-----------|
| Render speed | 2–10x faster | Slower |
| Bundle size | ~500KB (gzipped ~100KB) | ~500KB |
| API quality | Clean, modern | More complex |
| Maintenance | Active (Khan Academy) | Active |
| **Decision** | **Selected** | |

### Why remark/rehype plugins
- OpenChamber already uses `react-markdown` + `remark-gfm` in `MarkdownRenderer.tsx:820`
- `remark-math` + `rehype-katex` are the standard ecosystem plugins
- No custom parsing logic needed — clean integration

### Alternatives considered
| Alternative | Reason for rejection |
|-------------|----------------------|
| CDN scripts in `index.html` | Outside React tree, harder to theme, bypasses bundler |
| `react-katex` wrapper | Extra dependency; `rehype-katex` is sufficient |
| Custom regex preprocessor | Fragile, duplicates work already done by remark |

## Scope

### In Scope
- All markdown rendering via `MarkdownRenderer` and `SimpleMarkdownRenderer` (assistant messages, user messages, tool output, PR descriptions, file views)
- Light and dark theme color integration
- Inline (`$...$`) and display (`$$...$$`) math modes
- Standard LaTeX delimiters: `$...$` (inline), `$$...$$` (display), `\(` and `\[` (additional inline/display)

### Out of Scope
- Math input UI (user types LaTeX directly)
- Mermaid/math mixed blocks
- Server-side rendering considerations

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Bundle size increase | Low | Medium | KaTeX CSS only; JS tree-shaken by bundler |
| Theme color mismatch | Low | Low | CSS variable overrides in `index.css` |
| Breaking existing markdown | Very Low | Medium | Plugins are additive; no default behavior change |
| Rendering performance | Very Low | Low | KaTeX is synchronous and fast |

## Test Plan

### Functional Tests
1. Inline math `$x^2 + y^2 = z^2$` renders correctly
2. Display math `$$\frac{a}{b}$$` renders as centered block
3. Alternate delimiters `\(` and `\[` work
4. Math inside tables renders correctly
5. Math inside list items renders correctly
6. Code blocks adjacent to math still syntax-highlight
7. Escaped dollar signs `\$` do not trigger math mode
8. Math in user messages renders (if user markdown enabled)
9. Math in tool output renders
10. Math in PR descriptions renders

### Theme Tests
11. Light mode: KaTeX text color matches `--foreground`
12. Dark mode: KaTeX text color matches `--foreground`
13. KaTeX error color matches theme error color

### Edge Cases
14. Very long inline math expression wraps correctly
15. Very tall display math doesn't clip container
16. Nested markdown (bold inside math) handled gracefully

## References
- KaTeX: https://katex.org
- remark-math: https://github.com/remarkjs/remark-math
- rehype-katex: https://github.com/remarkjs/rehype-katex
