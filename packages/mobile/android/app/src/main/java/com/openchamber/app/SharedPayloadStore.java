package com.openchamber.app;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Holds the share that is waiting for the web layer, if any, and which shares are done.
 *
 * A share that a cold launch delivered before the page existed waits here instead of
 * being lost, and a newer share replaces an unread one.
 *
 * A share is done only when the page accepts it, or when a newer share replaces it before the
 * page did. One that is merely queued or being read is not: a recreated activity that comes
 * back with the same intent reads it again unless a read of it is still running or its
 * payload is still waiting here, and it never reads one that is done.
 */
public final class SharedPayloadStore {

    /** How many done shares are remembered; the activity restores only its launch intent. */
    static final int MAX_SETTLED = 16;

    /** The most the bridge hands the page at once. */
    public static final int MAX_FILES = 8;
    // The composer reads an attachment into the prompt below 10 MB and refuses it above, so a
    // larger share is rejected here, before it is copied, rather than after.
    public static final long MAX_FILE_BYTES = 10L * 1024 * 1024;
    public static final long MAX_BATCH_BYTES = 32L * 1024 * 1024;

    public static final String REASON_TOO_LARGE = "too-large";
    public static final String REASON_BATCH_LIMIT = "batch-limit";
    public static final String REASON_TOO_MANY = "too-many";
    public static final String REASON_UNSUPPORTED_TYPE = "unsupported-type";
    public static final String REASON_UNREADABLE = "unreadable";
    public static final String REASON_TIMED_OUT = "timed-out";

    /** Implemented by the plugin, which turns the callback into a "pending" event. */
    public interface Listener {
        void onPendingStored();
    }

    private static SharedPayload pending;
    private static Listener listener;
    private static final Set<String> inFlight = new HashSet<>();
    private static final LinkedHashSet<String> settled = new LinkedHashSet<>();

    private SharedPayloadStore() {}

    /**
     * Claims a share for reading. False when it is not a share, is done, is already queued or
     * being read, or its payload is waiting for the page; the caller then starts no reader.
     */
    public static synchronized boolean claim(String signature) {
        if (signature == null || settled.contains(signature) || inFlight.contains(signature)) {
            return false;
        }
        if (pending != null && signature.equals(pending.signature)) {
            return false;
        }
        inFlight.add(signature);
        return true;
    }

    /** A claimed share whose read produced nothing; a later launch with it may try again. */
    public static synchronized void release(String signature) {
        if (signature != null) {
            inFlight.remove(signature);
        }
    }

    /** A claimed share a newer one replaced before it was read; it is done without a payload. */
    public static synchronized void supersede(String signature) {
        if (signature != null) {
            inFlight.remove(signature);
            settle(signature);
        }
    }

    /** The done shares, for the activity's saved state. */
    public static synchronized ArrayList<String> settledSignatures() {
        return new ArrayList<>(settled);
    }

    /** Restores the done shares a previous process saved, so a recreation does not replay them. */
    public static synchronized void restoreSettled(Collection<String> signatures) {
        if (signatures == null) {
            return;
        }
        for (String signature : signatures) {
            if (signature != null) {
                settle(signature);
            }
        }
    }

    private static void settle(String signature) {
        settled.remove(signature);
        settled.add(signature);
        Iterator<String> oldest = settled.iterator();
        while (settled.size() > MAX_SETTLED && oldest.hasNext()) {
            oldest.next();
            oldest.remove();
        }
    }

    /** Forgets every share; tests only. */
    static synchronized void reset() {
        pending = null;
        inFlight.clear();
        settled.clear();
    }

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
            if (payload.signature != null) {
                inFlight.remove(payload.signature);
            }
            if (pending != null && pending.signature != null && !pending.signature.equals(payload.signature)) {
                settle(pending.signature);
            }
            pending = payload;
            target = listener;
        }
        // Outside the lock: the listener hops to the main thread and must not hold it.
        if (target != null) {
            target.onPendingStored();
        }
    }

    /**
     * Hands the waiting share to the page, or null when there is none. It stays waiting until the
     * page accepts it, so a page that is recreated before its draft holds the share gets it again.
     */
    public static synchronized SharedPayload take() {
        return pending;
    }

    /** The page holds this share in its draft: it is done and never read or handed over again. */
    public static synchronized void accept(String signature) {
        if (signature == null) {
            return;
        }
        if (pending != null && signature.equals(pending.signature)) {
            pending = null;
        }
        settle(signature);
    }

    /**
     * The refusal for one shared file, or null when it fits.
     *
     * An extra item is refused before its type or size matters, and a file that is too
     * large is refused before the batch. A size of -1 means the provider did not report one.
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

        /** {@link SharedIntentReader#signature} of the intent it was read from, or null. */
        public final String signature;
        public final String text;
        public final List<FilePayload> files;
        public final List<Rejection> rejected;

        public SharedPayload(String text, List<FilePayload> files, List<Rejection> rejected) {
            this(null, text, files, rejected);
        }

        public SharedPayload(String signature, String text, List<FilePayload> files, List<Rejection> rejected) {
            this.signature = signature;
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
