import { z } from 'zod';

import { runtimeFetch } from './runtime-fetch';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });

/**
 * Sends the user's answer to a secret an agent is waiting on (secret.request):
 * the value, or a decline. The server writes the value to a private file and
 * only the file's path reaches the agent. A request that no longer waits,
 * because it was answered elsewhere or its turn ended, is refused with the
 * server's message. `directory` is the session's: in an isolated space the
 * call waits on the space's own server, which is also where the agent's
 * commands read the file.
 */
export async function answerSecretRequest(
    input: { sessionId: string; callId: string } & ({ value: string } | { declined: true }),
    directory: string | undefined,
): Promise<void> {
    const response = await runtimeFetch('/api/openchamber/secret/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        directory,
    });
    if (response.ok) return;
    const payload = errorSchema.parse(await response.json().catch(() => null));
    throw new Error(payload.error || `The secret was not saved (${response.status})`);
}
