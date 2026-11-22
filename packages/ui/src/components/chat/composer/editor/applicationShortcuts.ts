import {
    eventMatchesShortcut,
    getEffectiveShortcutCombo,
    shortcutRegistry,
    type ShortcutActionId,
    type ShortcutCombo,
} from '@/lib/shortcuts';

/**
 * Application commands the composer hands to their handler before its editor
 * keymap sees the press. Moving work to the background may be rebound to
 * Ctrl+B, the OpenCode TUI's key, which the editor's macOS emacs keymap also
 * uses to move the caret; the user's binding wins inside the composer. When
 * nothing can go to the background the handler declines and the editor keeps
 * the key.
 */
const COMPOSER_FIRST_ACTIONS: readonly ShortcutActionId[] = ['background_session_work'];

/**
 * Runs the first matching composer-first command. A handled press is
 * prevented, so the editor leaves the caret alone, and stopped, so the window
 * dispatcher does not run the same command a second time.
 */
export function takeComposerApplicationShortcut(
    event: KeyboardEvent,
    overrides: Record<string, ShortcutCombo> | undefined,
    registry = shortcutRegistry,
): boolean {
    for (const actionId of COMPOSER_FIRST_ACTIONS) {
        if (!eventMatchesShortcut(event, getEffectiveShortcutCombo(actionId, overrides))) continue;
        for (const handler of registry.getAll(actionId)) {
            if (handler(event) === false) continue;
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
    }
    return false;
}
