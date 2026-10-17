import { z } from 'zod';

import type { JsonValue } from '@/lib/opencode/model';
import { runtimeFetch } from './runtime-fetch';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });

/**
 * Sends the user's answer to a page an agent is waiting on (render.page with
 * awaitAnswer). The agent's call is found by its session and call id; a page
 * that no longer waits, because it was answered elsewhere or its turn ended,
 * is refused with the server's message.
 */
export async function answerRenderedPage(input: {
    sessionId: string;
    callId: string;
    summary: string;
    data: JsonValue;
}): Promise<void> {
    const response = await runtimeFetch('/api/openchamber/render/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    if (response.ok) return;
    const payload = errorSchema.parse(await response.json().catch(() => null));
    throw new Error(payload.error || `The answer was not delivered (${response.status})`);
}
