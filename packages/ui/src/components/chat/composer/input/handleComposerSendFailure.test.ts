import { beforeEach, describe, expect, test } from 'bun:test';
import { toast as sonnerToast } from 'sonner';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { handleComposerSendFailure } from './handleComposerSendFailure';
import { useInputStore } from '@/sync/input-store';
import { markAmbiguousTransportFailure, markUndeliveredTransportFailure } from '@/lib/relay/transport-error';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { createComposerText } from '../state/composerText';
import { normalizeOpencodeError } from '@/lib/opencode/client';

const draft = createChatDraftIdentity('local', '/repo', 'ses_1');
const attachment: AttachedFile = {
  id: 'file_1', file: new File(['note'], 'notes.txt'), dataUrl: '', mimeType: 'text/plain', filename: 'notes.txt', size: 4, source: 'local',
};

const toastTitles = () => sonnerToast.getHistory().map((entry) => ('title' in entry ? entry.title : undefined));

const fail = (error: Error) => {
  const restoredText: unknown[] = [];
  const restoredFiles: AttachedFile[] = [];
  useInputStore.setState({ restoreAttachedFiles: (files) => { restoredFiles.push(...files); } });
  handleComposerSendFailure(error, {
    currentChatDraftIdentityRef: { current: draft },
    composerText: createComposerText(''),
    t: (key: string) => key,
    handoffDraft: () => {},
    restoreDraft: () => {},
    chatDraftIdentity: draft,
    sessionFolder: { tracked: false, missing: false, confirmed: false, recheck: () => {}, markMissing: () => {}, clearSendMark: () => {} },
    isBtwActive: false,
    allAttachments: [attachment],
    submitRuntimeKey: 'local',
    restoreConsumedDrafts: () => {},
    restoreComposerText: (target) => { restoredText.push(target); },
  });
  return { restoredText, restoredFiles };
};

beforeEach(() => {
  sonnerToast.dismiss();
});

describe('handleComposerSendFailure after a prompt lost to the network', () => {
  test('a response lost through the confirmation read returns the draft and files with a localized failure', () => {
    const before = toastTitles().length;
    const { restoredText, restoredFiles } = fail(markAmbiguousTransportFailure(new Error('session.prompt failed: transport failure')));
    expect(restoredText).toEqual([draft]);
    expect(restoredFiles).toEqual([attachment]);
    expect(toastTitles().slice(before)).toEqual(['chat.chatInput.toast.messageSendFailed']);
  });

  test('OpenCode unreachable through every resend returns the draft and files with a localized failure', () => {
    const before = toastTitles().length;
    const { restoredText, restoredFiles } = fail(markUndeliveredTransportFailure(new Error('session.prompt failed (503): OpenCode could not be reached')));
    expect(restoredText).toEqual([draft]);
    expect(restoredFiles).toEqual([attachment]);
    expect(toastTitles().slice(before)).toEqual(['chat.chatInput.toast.messageSendFailed']);
  });
});

describe('handleComposerSendFailure when OpenCode cannot load a skill', () => {
  test('an MCP skill its server fails to serve returns the draft with a localized failure', () => {
    const before = toastTitles().length;
    // The generated client throws a declared error as an Error carrying the response body.
    const declared = Object.assign(new Error('Failed to load SKILL.md of MCP skill docs:pdf: read failed'), { _tag: 'SkillLoadError', skill: 'docs:pdf' });
    const { restoredText } = fail(normalizeOpencodeError('session.prompt', declared));
    expect(restoredText).toEqual([draft]);
    expect(toastTitles().slice(before)).toEqual(['chat.chatInput.toast.skillLoadFailed']);
  });
});
