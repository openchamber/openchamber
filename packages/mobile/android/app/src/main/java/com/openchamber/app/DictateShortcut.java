package com.openchamber.app;

/**
 * The Dictate quick action. It opens a new session draft and starts the microphone, so it cannot
 * travel as an openchamber:// link: any app or web page can open one. The shortcut targets the
 * unexported {@code DictateShortcut} activity alias, which another app cannot start, and the
 * request waits here until the page takes it through {@link ShortcutRequestsPlugin}, so a cold
 * launch, where the intent arrives before the page has loaded, does not lose it.
 */
final class DictateShortcut {

    static final String ALIAS = "com.openchamber.app.DictateShortcut";

    interface Listener {
        void onPending();
    }

    private static boolean pending;
    private static Listener listener;

    private DictateShortcut() {}

    /**
     * Only an intent addressed to the alias counts. A restored activity, or one relaunched from
     * Recents, comes back with the intent it started with, and the user did not ask to record again.
     */
    static boolean isRequest(String componentClass, boolean launchedFromHistory, boolean restored) {
        return ALIAS.equals(componentClass) && !launchedFromHistory && !restored;
    }

    static void deliver() {
        Listener current;
        synchronized (DictateShortcut.class) {
            pending = true;
            current = listener;
        }
        if (current != null) {
            current.onPending();
        }
    }

    /** Hands the request out once. */
    static synchronized boolean take() {
        boolean requested = pending;
        pending = false;
        return requested;
    }

    static synchronized void setListener(Listener next) {
        listener = next;
    }

    static synchronized void clearListener(Listener current) {
        if (listener == current) {
            listener = null;
        }
    }

    static synchronized void reset() {
        pending = false;
        listener = null;
    }
}
