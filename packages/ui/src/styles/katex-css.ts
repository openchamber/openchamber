// Eagerly import KaTeX CSS so Vite correctly copies font files and rewrites URLs.
// This is imported from each app entry point (main.tsx, mobile-main.tsx, etc.),
// NOT from MarkdownRendererImpl (lazy chunk) — avoids the 1.13.1 flash issue.
// NOT via CSS @import — avoids the 1.13.2+ font file resolution bug.
import 'katex/dist/katex.min.css';
