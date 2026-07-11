/**
 * Shared chip geometry for tool rows and related message chips (radius + padding).
 * Keep info/status chips on this base so chat chrome stays visually consistent.
 */
export const TOOL_ROW_CHIP_GEOMETRY_CLASS = 'rounded-lg px-2 py-0.5';

/**
 * Codex-style interactive chip for chat tool / reasoning headers.
 * Matches sidebar session-row wash (neutral foreground mix — never theme/primary tint).
 * Background only appears on hover — idle rows stay flush with the message body.
 * Tight `py-0.5` keeps row height compact; `my-1.5` spaces tool rows apart.
 * `-mx-2` cancels `px-2` so hover wash expands outward without shifting icon/text.
 * `oc-tool-row` opts into pointer cursor even under desktop-runtime neutralization.
 */
export const TOOL_ROW_CHIP_CLASS =
  `oc-tool-row -mx-2 ${TOOL_ROW_CHIP_GEOMETRY_CLASS} my-1.5 cursor-pointer`;

/** Hover wash — same formula as sidebar `SIDEBAR_ROW_HOVER_CLASS`. */
export const TOOL_ROW_CHIP_HOVER_CLASS =
  'hover:bg-[color-mix(in_srgb,var(--surface-foreground)_6%,transparent)]';

/** Full interactive chrome: rounded padding + hover wash (for clickable tool / thinking headers). */
export const TOOL_ROW_INTERACTIVE_CHROME_CLASS = `${TOOL_ROW_CHIP_CLASS} ${TOOL_ROW_CHIP_HOVER_CLASS}`;

/**
 * Hover wash for draft project/branch selectors and composer footer controls.
 * Same neutral mix as sidebar / tool-row chips. Open state uses the stronger active wash.
 * Important modifiers beat SelectTrigger's default `hover:bg-interactive-hover`.
 */
export const SELECTOR_CHIP_HOVER_CLASS =
  'hover:!bg-[color-mix(in_srgb,var(--surface-foreground)_6%,transparent)] data-[popup-open]:!bg-[color-mix(in_srgb,var(--surface-foreground)_10%,transparent)] data-[state=open]:!bg-[color-mix(in_srgb,var(--surface-foreground)_10%,transparent)]';

/**
 * Composer text triggers (model / agent / variant).
 * Padding hugs the icon+label: wider X, tight Y — do not pair with a tall fixed `h-*`.
 */
export const COMPOSER_TRIGGER_CHROME_CLASS =
  `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 ${SELECTOR_CHIP_HOVER_CLASS}`;

/** Rounded hover wash for square composer icon buttons (+ / focus / shield / send). */
export const COMPOSER_ICON_HOVER_CLASS = `rounded-md ${SELECTOR_CHIP_HOVER_CLASS}`;
