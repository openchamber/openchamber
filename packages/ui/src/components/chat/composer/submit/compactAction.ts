type CompactSessionSummarizer = (
    sessionId: string,
    providerId: string,
    modelId: string,
    directory?: string | null,
) => Promise<boolean>;

type CompactActionOptions = {
    /** True for the footer button; typed `/compact` must keep its draft cleanup. */
    buttonTriggered: boolean;
    sessionId: string;
    providerId: string;
    modelId: string;
    currentDirectory?: string | null;
    getSessionDirectory: (sessionId: string) => string | null | undefined;
    consumeTypedCommand: () => void;
    waitForConnectionOrThrow: () => Promise<void>;
    summarizeSession: CompactSessionSummarizer;
};

/**
 * Run the session compaction action without entering the normal send pipeline.
 *
 * The button supplies the action out of band, so it must not run the typed
 * command cleanup or consume any composer inputs before summarizing.
 */
export async function executeCompactAction({
    buttonTriggered,
    sessionId,
    providerId,
    modelId,
    currentDirectory,
    getSessionDirectory,
    consumeTypedCommand,
    waitForConnectionOrThrow,
    summarizeSession,
}: CompactActionOptions): Promise<void> {
    if (!buttonTriggered) consumeTypedCommand();

    await waitForConnectionOrThrow();
    const directory = getSessionDirectory(sessionId) || currentDirectory || undefined;
    await summarizeSession(sessionId, providerId, modelId, directory);
}
