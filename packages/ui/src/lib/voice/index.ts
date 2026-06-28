/**
 * Voice module barrel export
 * Provides a clean import path for voice session hooks.
 *
 * @example
 * ```typescript
 * import { voiceHooks } from '@/lib/voice';
 * ```
 */

// Voice session registry (from voiceSession.ts)
export {
    isVoiceSessionStarted,
} from "./voiceSession";

// Voice hooks for session-to-voice event routing (from voiceHooks.ts)
export { voiceHooks } from "./voiceHooks";
