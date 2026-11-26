import { z } from 'zod';
import { vscodeSettingsNavigationSchema, type VSCodeSettingsNavigation } from '../../ui/src/lib/settings/vscodeNavigation';
import { isAppLinkScheme } from '../../ui/src/lib/appLinkSchemes';

const sessionIdSchema = z.string().trim().min(1).max(512);
const sessionTitleSchema = z.string().transform((value) => value.slice(0, 4096));

type ShowSettingsArgs = [] | [VSCodeSettingsNavigation];
type OpenSessionInEditorArgs = [string] | [string, string];

const showSettingsArgsSchema = z.union([
  z.tuple([]),
  z.tuple([vscodeSettingsNavigationSchema.nullish()]),
]).transform((args): ShowSettingsArgs => (args.length === 0 || args[0] == null ? [] : [args[0]]));

const closeSettingsArgsSchema = z.tuple([]);

const setActiveSessionArgsSchema = z.union([
  z.tuple([]),
  z.tuple([sessionIdSchema.nullish()]),
  z.tuple([sessionIdSchema.nullish(), sessionTitleSchema.nullish()]),
]);

const openSessionInEditorArgsSchema = z.union([
  z.tuple([sessionIdSchema]),
  z.tuple([sessionIdSchema, sessionTitleSchema.nullish()]),
]).transform((args): OpenSessionInEditorArgs => (args[1] == null ? [args[0]] : [args[0], args[1]]));

const openSessionArgsSchema = z.tuple([sessionIdSchema]);

export const commandEnvelopeSchema = z.object({
  command: z.string(),
});

export const allowedVSCodeCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('openchamber.showSettings'),
    args: showSettingsArgsSchema.optional().default([]),
  }),
  z.object({
    command: z.literal('openchamber.closeSettings'),
    args: closeSettingsArgsSchema.optional().default([]),
  }),
  z.object({
    command: z.literal('openchamber.setActiveSession'),
    args: setActiveSessionArgsSchema.optional().default([]),
  }),
  z.object({
    command: z.literal('openchamber.openSessionInEditor'),
    args: openSessionInEditorArgsSchema,
  }),
  z.object({
    command: z.literal('openchamber.internal.openSession'),
    args: openSessionArgsSchema,
  }),
]);

export const ALLOWED_VSCODE_COMMANDS = new Set(allowedVSCodeCommandSchema._zod.propValues.command);

export const settingsReadyCommandSchema = z.object({
  command: z.literal('openchamber.settingsReady'),
  args: z.tuple([]).optional(),
});

export const updateSessionEditorTitleCommandSchema = z.object({
  command: z.literal('openchamber.updateSessionEditorTitle'),
  args: z.union([
    z.tuple([sessionIdSchema]),
    z.tuple([sessionIdSchema, sessionTitleSchema.nullish()]),
  ]),
});

export const externalUrlPayloadSchema = z.object({
  url: z.string(),
});

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

type ExternalUrlDecision =
  | { action: 'open'; url: string; scheme: string }
  | { action: 'confirm'; url: string; scheme: string }
  | { action: 'refuse'; error: string };

export const decideExternalUrl = (rawUrl: string, editorUriScheme: string): ExternalUrlDecision => {
  const target = rawUrl.trim();
  if (!target) {
    return { action: 'refuse', error: 'URL is required' };
  }
  if (hasControlCharacters(target)) {
    return { action: 'refuse', error: 'Invalid URL' };
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { action: 'refuse', error: 'Invalid URL' };
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  const url = parsed.toString();
  if (scheme === 'http' || scheme === 'https') {
    if (!/^https?:\/\//i.test(target) || !parsed.hostname) {
      return { action: 'refuse', error: 'Invalid URL' };
    }
    return { action: 'open', url, scheme };
  }
  if (isAppLinkScheme(scheme, { editorUriScheme })) {
    return { action: 'confirm', url, scheme };
  }
  return { action: 'refuse', error: 'URL scheme cannot be opened externally' };
};
