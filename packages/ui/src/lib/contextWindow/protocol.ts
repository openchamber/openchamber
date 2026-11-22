import { z } from 'zod';
import { ROUTED_CONTEXT_ACTIONS } from './routing';

const CONTEXT_WINDOW_CHANNEL = 'openchamber.context-window';

const nullableString = z.string().nullable().catch(null);

const draftSchema = z.object({
  draftId: z.number(),
  open: z.boolean(),
  target: z.enum(['project', 'chat']).catch('project'),
  selectedProjectId: nullableString.optional(),
  directoryOverride: nullableString,
  bootstrapPendingDirectory: nullableString.optional(),
  preparedChatDirectory: nullableString.optional(),
  parentID: nullableString,
});

const inlineTargetSchema = z.object({ directory: z.string(), sessionKey: z.string() });

const attachmentTargetSchema = z.object({ runtimeKey: z.string(), directory: z.string(), sessionId: z.string().nullable() });

const followStateSchema = z.object({
  effectiveDirectory: nullableString,
  directory: nullableString,
  sessionId: nullableString,
  sessionDirectory: nullableString,
  draft: draftSchema.nullable().catch(null),
  composerAddress: z.object({ inline: inlineTargetSchema.nullable(), attachments: attachmentTargetSchema.nullable() }).nullable().catch(null),
});

export type ContextWindowFollowState = z.infer<typeof followStateSchema>;

const attachedFileSchema = z.object({
  id: z.string(),
  file: z.instanceof(File),
  dataUrl: z.string(),
  mimeType: z.string(),
  filename: z.string(),
  size: z.number(),
  source: z.enum(['local', 'server', 'vscode']),
  serverPath: z.string().optional(),
  vscodePath: z.string().optional(),
  vscodeSource: z.enum(['file', 'selection']).optional(),
  agentPath: z.string().optional(),
  sourceDocumentId: z.string().optional(),
  saveOnSend: z.boolean().optional(),
  saveCopyOnSend: z.boolean().optional(),
  original: z.object({ mimeType: z.string(), dataUrl: z.string(), saveOnSend: z.boolean().optional() }).optional(),
});

export const contextWindowMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('panel-hello'), ownerId: z.string() }),
  z.object({ kind: z.literal('panel-gone'), ownerId: z.string() }),
  z.object({ kind: z.literal('panel-returned'), ownerId: z.string() }),
  z.object({ kind: z.literal('owner-hello'), ownerId: z.string(), instance: z.string() }),
  z.object({ kind: z.literal('owner-taken'), ownerId: z.string(), instance: z.string() }),
  z.object({ kind: z.literal('owner-gone'), ownerId: z.string() }),
  z.object({ kind: z.literal('close'), ownerId: z.string() }),
  z.object({ kind: z.literal('return'), ownerId: z.string() }),
  z.object({ kind: z.literal('prefs'), ownerId: z.string(), fields: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal('follow'), ownerId: z.string(), state: followStateSchema }),
  z.object({ kind: z.literal('action'), ownerId: z.string(), action: z.enum(ROUTED_CONTEXT_ACTIONS), args: z.array(z.unknown()) }),
  z.object({
    kind: z.literal('attach'),
    ownerId: z.string(),
    requestId: z.string(),
    file: z.instanceof(Blob),
    name: z.string(),
    target: attachmentTargetSchema.nullable(),
    options: z.object({ shared: z.boolean().optional(), saveOnSend: z.enum(['reference', 'copy']).optional() }).optional(),
  }),
  z.object({ kind: z.literal('attached'), ownerId: z.string(), requestId: z.string(), files: z.array(attachedFileSchema).nullable().catch(null) }),
]);

export type ContextWindowMessage = z.infer<typeof contextWindowMessageSchema>;

export const openContextWindowChannel = (): BroadcastChannel | null => (
  'BroadcastChannel' in globalThis ? new BroadcastChannel(CONTEXT_WINDOW_CHANNEL) : null
);
