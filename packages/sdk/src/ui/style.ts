export const UI_CSS = `
.oc-sdk-stack,
.oc-sdk-stack * {
  box-sizing: border-box;
}
.oc-sdk-stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  container-type: inline-size;
  container-name: oc-sdk;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  font-family: var(--font-sans, var(--oc-font, inherit));
  font-size: 0.875rem;
  line-height: 1.45;
}
.oc-sdk-header {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  gap: 8px;
  min-width: 0;
  padding: 12px 12px 0;
}
[data-oc-surface="dialog"] .oc-sdk-header {
  padding: 8px 0 0;
}
.oc-sdk-controls {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 2px;
}
.oc-sdk-filters-slot {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
}
.oc-sdk-slot-list {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
.oc-sdk-search-wrap {
  flex: 0 0 auto;
  min-width: 0;
}
.oc-sdk-header:has(.oc-sdk-search-wrap[data-compact="true"]:not([data-open="true"])) .oc-sdk-search-wrap {
  display: none;
}
.oc-sdk-search-toggle-slot {
  display: none;
  flex: 0 0 auto;
}
.oc-sdk-header:has(.oc-sdk-search-wrap[data-compact="true"]:not([data-open="true"])) .oc-sdk-search-toggle-slot {
  display: flex;
}
.oc-sdk-search-field {
  position: relative;
}
.oc-sdk-search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  width: 16px;
  height: 16px;
  transform: translateY(-50%);
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  pointer-events: none;
}
.oc-sdk-search-wrap[data-active="true"] .oc-sdk-search-icon {
  color: var(--primary, var(--oc-primary, currentColor));
}
.oc-sdk-search {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-width: 0;
  height: 36px;
  border: 0;
  border-radius: 0.5625rem;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
  padding: 4px 12px 4px 36px;
  font: inherit;
  font-size: 0.875rem;
  line-height: 1.45;
  appearance: none;
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  transition: background 200ms ease-out, box-shadow 200ms ease-out;
}
.oc-sdk-search::placeholder {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
}
.oc-sdk-search:hover:not(:focus) {
  background: var(--surface-subtle, var(--oc-subtle, transparent));
  box-shadow: inset 0 0 0 1px transparent;
}
.oc-sdk-search:focus {
  box-shadow: inset 0 0 0 2px var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-search-toggle {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 0.4375rem;
  background: transparent;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  padding: 0;
  cursor: pointer;
}
.oc-sdk-search-close {
  position: absolute;
  top: 50%;
  right: 6px;
  display: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 0.4375rem;
  background: transparent;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  padding: 0;
  transform: translateY(-50%);
  cursor: pointer;
}
.oc-sdk-search-wrap[data-compact="true"][data-open="true"] .oc-sdk-search-close {
  display: flex;
}
.oc-sdk-search-wrap[data-compact="true"][data-open="true"] .oc-sdk-search {
  padding-right: 36px;
}
.oc-sdk-search-toggle:hover,
.oc-sdk-search-close:hover,
.oc-sdk-search-toggle:focus-visible,
.oc-sdk-search-close:focus-visible {
  background: var(--interactive-hover, var(--oc-hover, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-search-toggle:focus-visible,
.oc-sdk-search-close:focus-visible {
  outline: 2px solid var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-filters {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  flex: 1 1 auto;
  gap: 2px;
}
.oc-sdk-filter-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
}
.oc-sdk-filter-group[data-slot="start"] {
  flex: 1 1 auto;
}
.oc-sdk-filter-group[data-slot="end"] {
  flex: 0 0 auto;
}
.oc-sdk-filter-group[data-slot="start"] .oc-sdk-filter {
  min-width: 0;
  flex: 1 1 auto;
}
.oc-sdk-filter-group[data-slot="end"] .oc-sdk-filter {
  flex: 0 0 auto;
}
@container oc-sdk (max-width: 520px) {
  .oc-sdk-filter-group[data-slot="end"] .oc-sdk-filter-trigger {
    width: 32px;
    padding: 0;
    justify-content: center;
  }
  .oc-sdk-filter-group[data-slot="end"] .oc-sdk-filter-value,
  .oc-sdk-filter-group[data-slot="end"] .oc-sdk-filter-chevron {
    display: none;
  }
}
.oc-sdk-filter-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 32px;
  border: 0;
  border-radius: 0.4375rem;
  background: transparent;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  padding: 0 8px;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}
.oc-sdk-filter-trigger:hover {
  background: var(--interactive-hover, var(--oc-hover, transparent));
}
.oc-sdk-filter-trigger:focus-visible {
  outline: 2px solid var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-filter-trigger svg {
  flex: 0 0 auto;
}
.oc-sdk-filter-trigger[data-active="true"] .oc-sdk-filter-icon {
  color: var(--primary, var(--oc-primary, currentColor));
}
.oc-sdk-filter-icon {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
}
.oc-sdk-filter-value {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oc-sdk-filter-chevron {
  opacity: 0.6;
}
.oc-sdk-menu {
  position: fixed;
  z-index: 50;
  min-width: 10rem;
  padding: 4px;
  border: 0;
  border-radius: 0.75rem;
  --oc-glass-color: var(--surface-elevated, var(--oc-elevated));
  --oc-glass-opacity: 50%;
  --oc-glass-blur: 22px;
  --oc-glass-saturation: 1.24;
  background-color: color-mix(in srgb, var(--oc-glass-color) var(--oc-glass-opacity), transparent);
  -webkit-backdrop-filter: blur(var(--oc-glass-blur)) saturate(var(--oc-glass-saturation));
  backdrop-filter: blur(var(--oc-glass-blur)) saturate(var(--oc-glass-saturation));
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.8),
    inset 0 0 0 1px rgb(0 0 0 / 0.04),
    0 0 0 1px rgb(0 0 0 / 0.1),
    0 1px 2px -0.5px rgb(0 0 0 / 0.08),
    0 4px 8px -2px rgb(0 0 0 / 0.08),
    0 12px 20px -4px rgb(0 0 0 / 0.08);
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
html[data-oc-theme="dark"] .oc-sdk-menu {
  --oc-glass-opacity: 52%;
  --oc-glass-blur: 26px;
  --oc-glass-saturation: 1.16;
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.12),
    inset 0 0 0 1px rgb(255 255 255 / 0.08),
    0 0 0 1px rgb(0 0 0 / 0.36),
    0 1px 1px -0.5px rgb(0 0 0 / 0.22),
    0 3px 3px -1.5px rgb(0 0 0 / 0.2),
    0 6px 6px -3px rgb(0 0 0 / 0.16);
}
@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
  .oc-sdk-menu {
    background-color: var(--oc-glass-color);
  }
}
@media (prefers-reduced-transparency: reduce) {
  .oc-sdk-menu {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    background-color: var(--oc-glass-color);
  }
}
.oc-sdk-menu-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  border: 0;
  border-radius: 0.5625rem;
  background: transparent;
  color: inherit;
  padding: 4px 32px 4px 8px;
  font: inherit;
  font-size: 0.875rem;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  outline: none;
  user-select: none;
}
.oc-sdk-menu-item:hover,
.oc-sdk-menu-item:focus-visible {
  background: var(--interactive-hover, var(--oc-hover, transparent));
}
.oc-sdk-menu-item[aria-selected="true"] {
  background: var(--interactive-selection, var(--oc-selection, transparent));
}
.oc-sdk-menu-label {
  min-width: 0;
}
.oc-sdk-menu-check {
  pointer-events: none;
  position: absolute;
  top: 50%;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  color: var(--primary, var(--oc-primary, currentColor));
}
.oc-sdk-list {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 8px 12px;
}
[data-oc-surface="dialog"] .oc-sdk-list {
  padding: 8px 0 0;
}
.oc-sdk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  padding: 6px 4px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.oc-sdk-row:hover,
.oc-sdk-row:focus-visible {
  background: color-mix(in srgb, var(--interactive-hover, var(--oc-hover, currentColor)) 30%, transparent);
}
.oc-sdk-row[data-selected="true"] {
  background: color-mix(in srgb, var(--interactive-selection, var(--oc-selection, currentColor)) 30%, transparent);
}
.oc-sdk-id {
  box-sizing: border-box;
  flex: 0 0 4rem;
  width: 4rem;
  min-width: 4rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.875rem;
  line-height: 1.45;
  text-align: right;
}
.oc-sdk-title {
  flex: 1 1 auto;
  min-width: 0;
  margin-left: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  font-size: 0.875rem;
  line-height: 1.45;
}
.oc-sdk-badge,
.oc-sdk-subtitle {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.75rem;
  line-height: 1.35;
}
.oc-sdk-list-wrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
}
.oc-sdk-toggle-slot {
  display: flex;
  flex: 0 0 auto;
  min-width: 0;
  padding: 0 2px 4px;
}
.oc-sdk-toggle-slot[hidden] {
  display: none;
}
.oc-sdk-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.8125rem;
  line-height: 1.35;
  cursor: pointer;
}
.oc-sdk-more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin: 4px 0 8px;
  border: 0;
  border-radius: var(--oc-radius, 0.5625rem);
  background: transparent;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  padding: 8px;
  font: inherit;
  cursor: pointer;
}
.oc-sdk-more:hover,
.oc-sdk-more:focus-visible {
  background: color-mix(in srgb, var(--interactive-hover, var(--oc-hover, currentColor)) 30%, transparent);
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-open-slot {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  width: 20px;
  height: 20px;
  margin-right: 4px;
}
.oc-sdk-open {
  display: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  background: transparent;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  padding: 0;
  cursor: pointer;
}
.oc-sdk-row:hover .oc-sdk-open,
.oc-sdk-row:focus-visible .oc-sdk-open,
.oc-sdk-open:focus-visible {
  display: flex;
}
.oc-sdk-open:hover,
.oc-sdk-open:focus-visible {
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-empty {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  text-align: center;
  padding: 32px 8px;
}
.oc-sdk-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  font-family: var(--font-sans, var(--oc-font, inherit));
  font-size: 0.875rem;
  line-height: 1.45;
}
.oc-sdk-card-bar {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  padding: 8px 12px;
}
.oc-sdk-card-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  border: 0;
  border-radius: 0.4375rem;
  background: transparent;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  padding: 0 8px;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
}
.oc-sdk-card-back:hover,
.oc-sdk-card-open:hover,
.oc-sdk-card-back:focus-visible,
.oc-sdk-card-open:focus-visible {
  background: var(--interactive-hover, var(--oc-hover, transparent));
}
.oc-sdk-card-back:focus-visible,
.oc-sdk-card-open:focus-visible,
.oc-sdk-card-select:focus-visible,
.oc-sdk-card-secondary:focus-visible,
.oc-sdk-card-action:focus-visible {
  outline: 2px solid var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-card-open {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-left: auto;
  border: 0;
  border-radius: 0.4375rem;
  background: transparent;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  padding: 0;
  cursor: pointer;
}
.oc-sdk-card-open:hover {
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-card-body {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 12px 16px;
}
.oc-sdk-card-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.oc-sdk-card-id {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.875rem;
  line-height: 1.45;
}
.oc-sdk-card-title {
  margin: 2px 0 0;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.45;
}
.oc-sdk-card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.oc-sdk-card-select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  border: 1px solid var(--interactive-border, var(--oc-border, currentColor));
  border-radius: 0.4375rem;
  background: transparent;
  color: inherit;
  padding: 0 8px;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
}
.oc-sdk-card-select:hover {
  background: var(--interactive-hover, var(--oc-hover, transparent));
}
.oc-sdk-card-select:disabled,
.oc-sdk-card-secondary:disabled,
.oc-sdk-card-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.oc-sdk-card-secondary {
  display: inline-flex;
  align-items: center;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  border-radius: 0.4375rem;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  color: inherit;
  padding: 0 10px;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
}
.oc-sdk-card-secondary:hover {
  background: var(--interactive-hover, var(--oc-hover, transparent));
}
.oc-sdk-card-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.45;
}
.oc-sdk-card-dt {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
}
.oc-sdk-card-dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-card-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.oc-sdk-card-chip {
  display: inline-flex;
  max-width: 8rem;
  align-items: center;
  height: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 0.375rem;
  background: color-mix(in srgb, var(--surface-muted-foreground, var(--oc-muted, currentColor)) 12%, transparent);
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  padding: 0 6px;
  font-size: 0.875rem;
}
.oc-sdk-card-description {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-card-rich {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.oc-sdk-card-image {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.oc-sdk-card-link {
  color: var(--primary, var(--oc-primary, inherit));
  text-decoration: underline;
  overflow-wrap: anywhere;
}
.oc-sdk-card-muted {
  margin: 0;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
}
.oc-sdk-card-comments-title {
  margin: 0 0 8px;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.45;
}
.oc-sdk-card-thread {
  position: relative;
  padding-left: 12px;
}
.oc-sdk-card-comment {
  position: relative;
  padding: 0 0 20px 40px;
}
.oc-sdk-card-comment:last-child {
  padding-bottom: 0;
}
.oc-sdk-card-comment-line {
  position: absolute;
  top: 38px;
  bottom: 6px;
  left: 16px;
  width: 1px;
  background: color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
}
.oc-sdk-card-avatar {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  border-radius: 999px;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.75rem;
}
.oc-sdk-card-bubble {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: 0.5625rem;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  padding: 0 12px 12px;
}
.oc-sdk-card-comment-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.875rem;
}
.oc-sdk-card-comment-author {
  color: var(--surface-foreground, var(--oc-fg, inherit));
  white-space: nowrap;
}
.oc-sdk-card-foot {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  padding: 12px 16px;
}
.oc-sdk-card-action {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  border: 1px solid color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 12%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 10%, var(--surface-background, var(--oc-bg, transparent)));
  color: var(--primary, var(--oc-primary, currentColor));
  padding: 0 12px;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
html[data-oc-theme="dark"] .oc-sdk-card-action {
  border-color: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 20%, transparent);
  background: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 16%, transparent);
}
.oc-sdk-card-action:hover {
  background: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 16%, var(--surface-background, var(--oc-bg, transparent)));
}
html[data-oc-theme="dark"] .oc-sdk-card-action:hover {
  background: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 22%, transparent);
}
.oc-sdk-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  border-radius: 10px;
  padding: 0 12px;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.oc-sdk-btn[data-variant="default"] {
  border: 1px solid color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 12%, transparent);
  background: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 10%, var(--surface-background, var(--oc-bg, transparent)));
  color: var(--primary, var(--oc-primary, currentColor));
}
html[data-oc-theme="dark"] .oc-sdk-btn[data-variant="default"] {
  border-color: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 20%, transparent);
  background: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 16%, transparent);
}
.oc-sdk-btn[data-variant="default"]:hover {
  background: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 16%, var(--surface-background, var(--oc-bg, transparent)));
}
html[data-oc-theme="dark"] .oc-sdk-btn[data-variant="default"]:hover {
  background: color-mix(in srgb, var(--primary, var(--oc-primary, currentColor)) 22%, transparent);
}
.oc-sdk-btn[data-variant="secondary"] {
  border: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-btn[data-variant="secondary"]:hover {
  background: var(--interactive-hover, var(--oc-hover, transparent));
}
.oc-sdk-btn[data-variant="ghost"] {
  border: 1px solid transparent;
  background: transparent;
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-btn[data-variant="ghost"]:hover {
  background: var(--interactive-hover, var(--oc-hover, transparent));
}
.oc-sdk-btn[data-variant="destructive"] {
  border: 1px solid color-mix(in srgb, var(--status-error, #c23) 24%, transparent);
  background: color-mix(in srgb, var(--status-error, #c23) 10%, transparent);
  color: var(--status-error, #c23);
}
.oc-sdk-btn[data-variant="destructive"]:hover {
  background: color-mix(in srgb, var(--status-error, #c23) 16%, transparent);
}
.oc-sdk-btn:focus-visible {
  outline: 2px solid var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.oc-sdk-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.oc-sdk-field-label {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.4;
}
.oc-sdk-field-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 36px;
  border: 0;
  border-radius: 0.5625rem;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
  padding: 4px 12px;
  font: inherit;
  font-size: 0.875rem;
  appearance: none;
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
}
.oc-sdk-field-input:focus {
  box-shadow: inset 0 0 0 2px var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-field-input:disabled {
  opacity: 0.5;
}
.oc-sdk-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 100%;
  padding: 32px 20px;
  text-align: center;
}
.oc-sdk-empty-title {
  margin: 0;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.45;
}
.oc-sdk-empty-body {
  margin: 0;
  max-width: 22rem;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.875rem;
  line-height: 1.45;
}
.oc-sdk-empty-action {
  margin-top: 8px;
}
.oc-sdk-pr {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  container-type: inline-size;
  container-name: oc-sdk-pr;
  color: var(--surface-foreground, var(--oc-fg, inherit));
  font-family: var(--font-sans, var(--oc-font, inherit));
  font-size: 0.875rem;
  line-height: 1.45;
}
.oc-sdk-pr-bar {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  padding: 8px 12px;
}
.oc-sdk-pr-heading {
  min-width: 0;
  flex: 1 1 auto;
}
.oc-sdk-pr-kicker {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.75rem;
}
.oc-sdk-pr-title {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9375rem;
  font-weight: 600;
}
.oc-sdk-pr-tools {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}
.oc-sdk-pr-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 0.4375rem;
  background: transparent;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  padding: 0;
  cursor: pointer;
}
.oc-sdk-pr-icon:hover,
.oc-sdk-pr-icon:focus-visible {
  background: var(--interactive-hover, var(--oc-hover, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-pr-icon:focus-visible,
.oc-sdk-pr-tab:focus-visible,
.oc-sdk-pr-save:focus-visible {
  outline: 2px solid var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-pr-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  flex: 0 0 auto;
  padding: 8px 12px 0;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.75rem;
}
.oc-sdk-pr-state[data-state="open"] { color: var(--status-success, #2a7); }
.oc-sdk-pr-state[data-state="draft"] { color: var(--surface-muted-foreground, var(--oc-muted, gray)); }
.oc-sdk-pr-state[data-state="merged"] { color: var(--status-info, #46c); }
.oc-sdk-pr-state[data-state="closed"] { color: var(--status-error, #c23); }
.oc-sdk-pr-tabs {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  padding: 8px 12px 0;
}
.oc-sdk-pr-tab {
  height: 28px;
  border: 0;
  border-radius: 0.4375rem;
  background: transparent;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  padding: 0 10px;
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.oc-sdk-pr-tab[aria-selected="true"] {
  background: var(--interactive-selection, var(--oc-selection, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-pr-tab:hover,
.oc-sdk-pr-tab:focus-visible {
  color: var(--surface-foreground, var(--oc-fg, inherit));
}
.oc-sdk-pr-body {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 12px 16px;
}
.oc-sdk-pr-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.oc-sdk-pr-create {
  gap: 16px;
}
.oc-sdk-pr-route-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: 0.75rem;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  padding: 12px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
}
.oc-sdk-pr-route {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: end;
  gap: 8px;
  min-width: 0;
}
.oc-sdk-pr-pick {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.oc-sdk-pr-pick-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  border: 0;
  border-radius: 0.5625rem;
  background: var(--surface-background, var(--oc-bg, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
  padding: 6px 10px;
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
}
.oc-sdk-pr-pick-trigger:hover:not(:disabled) {
  background: var(--interactive-hover, var(--oc-hover, transparent));
}
.oc-sdk-pr-pick-trigger[data-open="true"] {
  background: var(--interactive-selection, var(--oc-selection, transparent));
  color: var(--interactive-selection-foreground, var(--oc-fg, inherit));
}
.oc-sdk-pr-pick-trigger:focus-visible {
  outline: 2px solid var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-pr-pick-trigger:disabled {
  opacity: 0.6;
  cursor: default;
}
.oc-sdk-pr-pick-value {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oc-sdk-pr-pick-trigger[data-empty="true"] .oc-sdk-pr-pick-value {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
}
.oc-sdk-pr-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  font-size: 0.875rem;
}
.oc-sdk-pr-route-view {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.oc-sdk-pr-chip {
  display: inline-flex;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 999px;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
  padding: 2px 8px;
  font-size: 0.75rem;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 50%, transparent);
}
.oc-sdk-pr-arrow-inline {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
}
@container oc-sdk-pr (max-width: 420px) {
  .oc-sdk-pr-route {
    grid-template-columns: minmax(0, 1fr);
  }
  .oc-sdk-pr-arrow {
    height: auto;
    transform: rotate(90deg);
  }
}
.oc-sdk-pr-check {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  border-radius: 0.4375rem;
  padding: 8px 10px;
}
.oc-sdk-pr-file {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  border-radius: 0.75rem;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
}
.oc-sdk-pr-file-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-bottom: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 50%, transparent);
  padding: 8px 10px;
  font-size: 0.8125rem;
  font-weight: 600;
}
.oc-sdk-pr-diff {
  margin: 0;
  max-height: 22rem;
  overflow: auto;
  padding: 6px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.75rem;
  line-height: 1.45;
}
.oc-sdk-pr-diff-line {
  padding: 0 10px;
  white-space: pre;
}
.oc-sdk-pr-diff-line[data-kind="add"] {
  background: color-mix(in srgb, var(--status-success, #2a7) 14%, transparent);
  color: var(--status-success, #2a7);
}
.oc-sdk-pr-diff-line[data-kind="del"] {
  background: color-mix(in srgb, var(--status-error, #c23) 14%, transparent);
  color: var(--status-error, #c23);
}
.oc-sdk-pr-diff-line[data-kind="hunk"],
.oc-sdk-pr-diff-line[data-kind="meta"] {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
}
.oc-sdk-pr-check[data-state="failure"] {
  border-color: color-mix(in srgb, var(--status-error, #c23) 40%, transparent);
}
.oc-sdk-pr-check-name {
  font-weight: 500;
}
.oc-sdk-pr-check-detail {
  color: var(--surface-muted-foreground, var(--oc-muted, gray));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.oc-sdk-pr-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--surface-muted-foreground, var(--oc-muted, gray));
}
.oc-sdk-pr-dot[data-state="success"] { background: var(--status-success, #2a7); }
.oc-sdk-pr-dot[data-state="failure"] { background: var(--status-error, #c23); }
.oc-sdk-pr-dot[data-state="pending"],
.oc-sdk-pr-dot[data-state="queued"],
.oc-sdk-pr-dot[data-state="running"] { background: var(--status-warning, #c90); }
.oc-sdk-field-area {
  box-sizing: border-box;
  width: 100%;
  min-height: 96px;
  resize: vertical;
  border: 0;
  border-radius: 0.5625rem;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  color: var(--surface-foreground, var(--oc-fg, inherit));
  padding: 8px 12px;
  font: inherit;
  font-size: 0.875rem;
  appearance: none;
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
}
.oc-sdk-field-area:focus {
  box-shadow: inset 0 0 0 2px var(--interactive-focus-ring, var(--oc-focus, currentColor));
}
.oc-sdk-pr-save,
.oc-sdk-pr-draft {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.oc-sdk-pr-foot {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 8px;
  border-top: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  padding: 12px 16px;
}
.oc-sdk-pr-merge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.oc-sdk-pr-select {
  height: 36px;
  border: 1px solid color-mix(in srgb, var(--interactive-border, var(--oc-border, currentColor)) 60%, transparent);
  border-radius: 10px;
  background: var(--surface-elevated, var(--oc-elevated, transparent));
  color: inherit;
  padding: 0 8px;
  font: inherit;
}
`;
