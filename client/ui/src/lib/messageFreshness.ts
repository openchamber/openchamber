import type { Message } from '@opencode-ai/sdk/v2';

export class MessageFreshnessDetector {
    private static instance: MessageFreshnessDetector;
    private sessionStartTimes: Map<string, number> = new Map();
    private seenMessageIds: Set<string> = new Set();
    private messageCreationTimes: Map<string, number> = new Map();

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

    shouldAnimateMessage(message: Message, sessionId: string): boolean {

        if (message.role !== 'assistant') {
            return false;
        }

        if (this.seenMessageIds.has(message.id)) {
            return false;
        }

        const sessionStartTime = this.sessionStartTimes.get(sessionId);

        if (!sessionStartTime) {

            this.seenMessageIds.add(message.id);
            this.messageCreationTimes.set(message.id, message.time.created);
            return false;
        }

        const isFresh = message.time.created > (sessionStartTime - 5000);

        if (!isFresh) {
            this.seenMessageIds.add(message.id);
            this.messageCreationTimes.set(message.id, message.time.created);
        }

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

    markMessageAsAnimated(messageId: string, createdTime: number): void {
        this.seenMessageIds.add(messageId);
        this.messageCreationTimes.set(messageId, createdTime);
    }

    clearAll(): void {
        this.sessionStartTimes.clear();
        this.seenMessageIds.clear();
        this.messageCreationTimes.clear();
    }

    getDebugInfo(): {
        sessionStartTimes: Map<string, number>;
        seenMessageIds: Set<string>;
        messageCreationTimes: Map<string, number>;
    } {
        return {
            sessionStartTimes: new Map(this.sessionStartTimes),
            seenMessageIds: new Set(this.seenMessageIds),
            messageCreationTimes: new Map(this.messageCreationTimes)
        };
    }
}