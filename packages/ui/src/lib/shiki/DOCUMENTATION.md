# Highlighting adapters

## Ownership

This module owns app-theme conversion and registration for Shiki, Highlights and Pierre diffs. Theme roles belong to `../theme`, and renderers own their content.

## Invariants

- Workers and main-thread diff renderers use one highlighter type because Pierre permits one type per thread. Highlights requires WebAssembly SIMD; the fallback uses Shiki's JavaScript engine.
- Missing lexers use related languages only where the requested engine lacks its own lexer. Diff language inference applies the shared filename mapping, keeping files, editor and chat colors aligned.
- Theme registration uses content-sensitive render names and shares cached conversions; the canonical identity and color contract is in `../theme/DOCUMENTATION.md`. Chat uses CSS variables so theme switches do not retokenize content, while file and diff themes use concrete supported colors.
- Changed-row tint is reduced inside each diff's shadow root because full theme red and green fills overwhelm code. Between-hunk rows retain the diff background and the virtualized view's shared 24 px height so tool and Changes diffs align.
