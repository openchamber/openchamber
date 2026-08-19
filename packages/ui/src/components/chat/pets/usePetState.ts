/**
 * Maps live OpenChamber session activity to the four pet display states,
 * mirroring the Codex notification semantics:
 *
 *   busy      -> running
 *   retry     -> blocked
 *   idle + pending permission/question -> needs-input
 *   other idle -> ready
 *
 * The pending check must happen before the phase check because
 * `useSessionActivity` intentionally reports idle while permissions or
 * questions are waiting for the user.
 */

import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';
import type { PetDisplayState } from './animations';

export function usePetState(): PetDisplayState {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const permissions = useSessionPermissions(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const questions = useSessionQuestions(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const { phase } = useCurrentSessionActivity();

    if (phase === 'busy') return 'running';
    if (phase === 'retry') return 'blocked';
    if (permissions.length > 0 || questions.length > 0) return 'needs-input';
    return 'ready';
}
