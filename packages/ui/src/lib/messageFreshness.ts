import type { Message } from '@/lib/opencode/model';

// Upper bound on the seen-message set below. The detector is a page-lifetime
// singleton, so without a cap the set grows by one entry for every assistant
// message ever rendered. The cap is far above the visible/recent working set
// of any session.
export const MAX_SEEN_MESSAGE_IDS = 2000;

// How long after creation a message may still animate on first render, in
// milliseconds. Freshness is checked against the current time as well as
// the stored session start (see shouldAnimateMessage), so this window
// genuinely expires: an id evicted from the capped seen set cannot
// re-animate hours later by passing freshness against a stale session
// start that was never refreshed (regression #2124, Codex review on #1014).
const FRESHNESS_WINDOW_MS = 5000;

export class MessageFreshnessDetector {
    private static instance: MessageFreshnessDetector;
    private sessionStartTimes: Map<string, number> = new Map();
    private seenMessageIds: Set<string> = new Set();

    private constructor() {}

    static getInstance(): MessageFreshnessDetector {
        if (!MessageFreshnessDetector.instance) {
            MessageFreshnessDetector.instance = new MessageFreshnessDetector();
        }
        return MessageFreshnessDetector.instance;
    }

    recordSessionStart(sessionId: string): void {
        this.sessionStartTimes.set(sessionId, Date.now());
    }

    getSessionStartTime(sessionId: string): number | undefined {
        return this.sessionStartTimes.get(sessionId);
    }

    private recordSeenMessage(messageId: string): void {
        this.seenMessageIds.add(messageId);
        while (this.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
            const oldest = this.seenMessageIds.values().next().value;
            if (oldest === undefined) break;
            this.seenMessageIds.delete(oldest);
        }
    }

    shouldAnimateMessage(message: Message, sessionId: string): boolean {

        if (message.role !== 'assistant') {
            return false;
        }

        if (this.seenMessageIds.has(message.id)) {
            return false;
        }

        const sessionStartTime = this.sessionStartTimes.get(sessionId);

        if (!sessionStartTime) {

            this.recordSeenMessage(message.id);
            return false;
        }

        // Fresh means created after the session start (with the window as
        // grace for messages that landed just before the session opened)
        // AND still inside the window right now. The second clause is what
        // makes the window expire: comparing only against the stored
        // session start would let a message whose seen id was evicted from
        // the capped set pass freshness forever, replaying its animation
        // when the session is revisited before recordSessionStart runs
        // again (regression #2124).
        const isFresh =
            message.time.created > sessionStartTime - FRESHNESS_WINDOW_MS &&
            message.time.created > Date.now() - FRESHNESS_WINDOW_MS;

        // Record fresh messages too so they animate at most once per detector
        // lifetime. The detector is a module singleton that outlives ChatViewport
        // remounts; without this, switching away and back re-evaluates the same
        // message against the stale session start time (recordSessionStart runs
        // in an effect after the first render) and replays the entry animation.
        this.recordSeenMessage(message.id);

        return isFresh;
    }

    clearSession(sessionId: string): void {
        this.sessionStartTimes.delete(sessionId);

    }

     hasSessionTiming(sessionId: string): boolean {
         return this.sessionStartTimes.has(sessionId);
     }

     hasBeenAnimated(messageId: string): boolean {
        return this.seenMessageIds.has(messageId);
    }

    markMessageAsAnimated(messageId: string): void {
        this.recordSeenMessage(messageId);
    }

    clearAll(): void {
        this.sessionStartTimes.clear();
        this.seenMessageIds.clear();
    }

    getDebugInfo(): {
        sessionStartTimes: Map<string, number>;
        seenMessageIds: Set<string>;
    } {
        return {
            sessionStartTimes: new Map(this.sessionStartTimes),
            seenMessageIds: new Set(this.seenMessageIds)
        };
    }
}
