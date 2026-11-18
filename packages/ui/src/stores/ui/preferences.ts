import type { FileEditorKeymap, LargeTextPasteBehavior } from './types';

export const clampContextEditorTreeWidth = (width: number): number =>
  Math.min(480, Math.max(200, Math.round(width)));

export const DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR: LargeTextPasteBehavior = 'ask';

export const normalizeLargeTextPasteBehavior = (value: unknown): LargeTextPasteBehavior => {
  if (value === 'attach' || value === 'inline' || value === 'ask' || value === 'inline-double-paste') {
    return value;
  }
  return DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR;
};

export function normalizeFileEditorKeymap(value: unknown): FileEditorKeymap {
  return value === 'vim' ? 'vim' : 'default';
}

export const DEFAULT_SELECTION_APPROVAL_TEXT = 'Sounds good';

export const DEFAULT_EDITOR_FONT_SIZE = 12;

export const DEFAULT_CONTEXT_EDITOR_TREE_WIDTH = 208;
