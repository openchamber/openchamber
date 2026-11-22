import { z } from 'zod';
import { CONTINUE_WORK_MODES } from '@/lib/opencode/model-handoff';
import type { ActiveRunModelChangeBehavior, AgentTerminalsPlacement, DocumentAttachBehavior, FileEditorKeymap, LargeTextPasteBehavior } from './types';

export const clampContextEditorTreeWidth = (width: number): number =>
  Math.min(480, Math.max(200, Math.round(width)));

export const DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR: LargeTextPasteBehavior = 'ask';

export const largeTextPasteBehaviorSchema = z.enum(['ask', 'attach', 'inline', 'inline-double-paste'])
  .catch(DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR) satisfies z.ZodType<LargeTextPasteBehavior>;

export const DEFAULT_AGENT_TERMINALS_PLACEMENT: AgentTerminalsPlacement = 'terminal-panel';

export const agentTerminalsPlacementSchema = z.enum(['terminal-panel', 'sidebar'])
  .catch(DEFAULT_AGENT_TERMINALS_PLACEMENT) satisfies z.ZodType<AgentTerminalsPlacement>;

/** Stopping everything is the default; keeping work running is the choice a user makes. */
export const continueWithModelModeSchema = z.enum(CONTINUE_WORK_MODES).catch('stop');

export const DEFAULT_ACTIVE_RUN_MODEL_CHANGE_BEHAVIOR: ActiveRunModelChangeBehavior = 'next-message';

export const activeRunModelChangeBehaviorSchema = z.enum(['next-message', 'restart'])
  .catch(DEFAULT_ACTIVE_RUN_MODEL_CHANGE_BEHAVIOR) satisfies z.ZodType<ActiveRunModelChangeBehavior>;

// A plain slice at a cap can land between the halves of a surrogate pair
// and persist a value whose last code unit is a lone high surrogate
// (U+FFFD once encoded); drop the partial character so the stored value
// ends on a pair boundary. Same pattern as the PWA clips (#2029/#2031)
// and the server settings-helpers clips (#2028).
export const clipPairSafe = (text: string, limit: number): string => {
  const clipped = text.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

export const DEFAULT_DOCUMENT_ATTACH_BEHAVIOR: DocumentAttachBehavior = 'ask';

export const documentAttachBehaviorSchema = z.enum(['ask', 'save', 'convert']).catch(DEFAULT_DOCUMENT_ATTACH_BEHAVIOR);

export const fileEditorKeymapSchema = z.enum(['default', 'vim']).catch('default') satisfies z.ZodType<FileEditorKeymap>;

export const DEFAULT_SELECTION_APPROVAL_TEXT = 'Sounds good';

export const DEFAULT_EDITOR_FONT_SIZE = 12;

export const DEFAULT_CONTEXT_EDITOR_TREE_WIDTH = 208;
