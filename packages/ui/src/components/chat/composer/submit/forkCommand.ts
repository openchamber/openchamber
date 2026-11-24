
import type { Session } from '@/lib/opencode/model';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { OPENCODE_REQUEST_TIMEOUT_MS } from '@/lib/opencode/client';
import { waitAtMost } from '@/lib/timing/waitAtMost';
import { MODEL_SWITCH_FAILED, whenModelPickWritten } from '@/sync/model-gesture';

export interface ForkSendSelection {
    providerID: string;
    modelID: string;
    agent?: string;
    variant?: string;
}

export interface ForkCommandDeps {
    fork: (sessionId: string) => Promise<Session | null>;
    directoryFor: (session: Session) => string | null;
    send: (text: string, selection: ForkSendSelection, target: { sessionId: string; directory?: string }) => Promise<void>;
    draftIdentity: (directory: string | null, sessionId: string) => ChatDraftIdentity | null;
    restoreText: (target: ChatDraftIdentity, text: string) => void;
}

export type ForkCommandOutcome = 'forked' | 'sent' | 'send-failed' | 'stale';

export async function runForkCommand(
    sourceSessionId: string,
    prompt: string,
    selection: ForkSendSelection,
    deps: ForkCommandDeps,
): Promise<ForkCommandOutcome> {
    let pickWritten = false;
    await waitAtMost(OPENCODE_REQUEST_TIMEOUT_MS, whenModelPickWritten(sourceSessionId).then(() => { pickWritten = true; }));
    if (!pickWritten) throw new Error(MODEL_SWITCH_FAILED);
    const forked = await deps.fork(sourceSessionId);
    if (!forked) return 'stale';
    const text = prompt.trim();
    if (!text) return 'forked';

    const directory = deps.directoryFor(forked);
    try {
        await deps.send(text, selection, { sessionId: forked.id, directory: directory ?? undefined });
        return 'sent';
    } catch (error) {
        console.error('Failed to send the /fork message:', error);
        const target = deps.draftIdentity(directory, forked.id);
        if (target) deps.restoreText(target, text);
        return 'send-failed';
    }
}
