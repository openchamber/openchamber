// KaTeX's stylesheet must be imported through JavaScript, not through the CSS
// `@import` in index.css. Lightning CSS (Tailwind v4) inlines the imported CSS
// but does not resolve its relative `url(fonts/...)` references, so the
// KaTeX_* font files were never emitted and every formula fell back to the
// container font instead of KaTeX's math typefaces (openchamber/openchamber#1880).
//
// Vite's JS-import pipeline does resolve those URLs: it copies the .woff2 files
// to the build output and rewrites the references. Every app entry point that
// loads `styles/fonts` must also load this module, before index.css, so the
// base stylesheet stays ahead of the theme overrides in index.css.
import 'katex/dist/katex.min.css';
