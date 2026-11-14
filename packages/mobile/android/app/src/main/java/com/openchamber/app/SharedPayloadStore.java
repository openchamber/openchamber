package com.openchamber.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Holds the share that is waiting for the web layer, if any.
 *
 * A share that a cold launch delivered before the page existed waits here instead of
 * being lost, and a newer share replaces an unread one.
 */
public final class SharedPayloadStore {

    /** The most the bridge hands the page at once; matches the iOS share extension. */
    public static final int MAX_FILES = 8;
    public static final long MAX_FILE_BYTES = 24L * 1024 * 1024;
    public static final long MAX_BATCH_BYTES = 32L * 1024 * 1024;

    public static final String REASON_TOO_LARGE = "too-large";
    public static final String REASON_BATCH_LIMIT = "batch-limit";
    public static final String REASON_TOO_MANY = "too-many";
    public static final String REASON_UNSUPPORTED_TYPE = "unsupported-type";
    public static final String REASON_UNREADABLE = "unreadable";

    /** Implemented by the plugin, which turns the callback into a "pending" event. */
    public interface Listener {
        void onPendingStored();
    }

    private static SharedPayload pending;
    private static Listener listener;

    private SharedPayloadStore() {}

    public static synchronized void setListener(Listener value) {
        listener = value;
    }

    public static synchronized void clearListener(Listener value) {
        if (listener == value) {
            listener = null;
        }
    }

    /** Replaces whatever was waiting: the newest share is the one the page receives. */
    public static void put(SharedPayload payload) {
        if (payload == null) {
            return;
        }
        Listener target;
        synchronized (SharedPayloadStore.class) {
            pending = payload;
            target = listener;
        }
        // Outside the lock: the listener hops to the main thread and must not hold it.
        if (target != null) {
            target.onPendingStored();
        }
    }

    /** Hands the waiting share to the caller, or null when there is none. */
    public static synchronized SharedPayload take() {
        SharedPayload payload = pending;
        pending = null;
        return payload;
    }

    /**
     * The refusal for one shared file, or null when it fits.
     *
     * Precedence matches the iOS share extension: an extra item is refused before its
     * type or size matters, and a file that is too large is refused before the batch.
     * A size of -1 means the provider did not report one.
     */
    public static String rejectionReason(int index, long size, long batchSoFar, boolean typeSupported, boolean readable) {
        if (index >= MAX_FILES) {
            return REASON_TOO_MANY;
        }
        if (!typeSupported) {
            return REASON_UNSUPPORTED_TYPE;
        }
        if (size > MAX_FILE_BYTES) {
            return REASON_TOO_LARGE;
        }
        if (size >= 0 && batchSoFar + size > MAX_BATCH_BYTES) {
            return REASON_BATCH_LIMIT;
        }
        if (!readable) {
            return REASON_UNREADABLE;
        }
        return null;
    }

    public static final class FilePayload {
        public final String name;
        public final String mimeType;
        /** Base64 without line breaks. */
        public final String data;

        public FilePayload(String name, String mimeType, String data) {
            this.name = name;
            this.mimeType = mimeType;
            this.data = data;
        }
    }

    public static final class Rejection {
        public final String name;
        public final String reason;

        public Rejection(String name, String reason) {
            this.name = name;
            this.reason = reason;
        }
    }

    public static final class SharedPayload {
        public static final SharedPayload EMPTY = new SharedPayload(null, null, null);

        public final String text;
        public final List<FilePayload> files;
        public final List<Rejection> rejected;

        public SharedPayload(String text, List<FilePayload> files, List<Rejection> rejected) {
            this.text = text;
            this.files = copyOf(files);
            this.rejected = copyOf(rejected);
        }

        private static <T> List<T> copyOf(List<T> items) {
            return items == null
                ? Collections.<T>emptyList()
                : Collections.unmodifiableList(new ArrayList<>(items));
        }
    }
}
