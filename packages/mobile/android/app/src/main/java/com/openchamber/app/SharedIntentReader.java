package com.openchamber.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Turns a share intent into the payload SharedFiles.takePending hands to the page. */
final class SharedIntentReader {

    private static final int CHUNK_BYTES = 64 * 1024;
    /** A provider that stops serving bytes must not hold the reader until the process dies. */
    static final long DEFAULT_READ_TIMEOUT_MS = 15_000;
    /** The whole share, so eight stalled files cannot add up to two minutes. */
    static final long DEFAULT_SHARE_DEADLINE_MS = 30_000;
    /** Consecutive zero-byte reads before the stream is treated as stalled. */
    private static final int MAX_EMPTY_READS = 8;
    /**
     * Per-file reads still running, including ones abandoned at their deadline because the
     * provider is stuck in a call that cannot be interrupted. Past this many, a file is refused
     * without asking its provider, so stalled providers cannot pile up threads.
     */
    static final int MAX_OUTSTANDING_READS = 3;
    private static final AtomicInteger outstandingReads = new AtomicInteger();

    /**
     * The delivery an intent belongs to. Each share the activity receives gets its own, so sharing
     * the same link twice is two shares, while a recreated activity restoring one is not.
     */
    static final String EXTRA_DELIVERY = "com.openchamber.app.SHARE_DELIVERY";

    /** Whether this app may read a shared URI; production asks Android for the read grant. */
    interface ReadGrant {
        boolean granted(Uri uri);
    }

    private SharedIntentReader() {}

    /**
     * Identifies one delivery of a share: its content plus the delivery the activity stamped on
     * it, so a recreated activity can tell a new share from the intent it is restored with.
     * Null when the intent is not a share.
     */
    static String signature(Intent intent) {
        String content = contentSignature(intent);
        if (content == null) {
            return null;
        }
        try {
            String delivery = intent.getStringExtra(EXTRA_DELIVERY);
            return delivery == null ? content : content + "|delivery=" + delivery;
        } catch (RuntimeException malformed) {
            return null;
        }
    }

    /**
     * The delivery to read an intent the activity starts with under, or null when it must not be
     * read. A restored activity reads only the share it last received, under that delivery: an
     * older intent it comes back with was settled or replaced when the newer one arrived. A launch
     * from recents replays an old intent and is never a share.
     */
    static String launchDelivery(
        String content,
        String stamped,
        boolean restored,
        String savedContent,
        String savedDelivery,
        boolean fromHistory,
        String fresh
    ) {
        if (content == null) {
            return null;
        }
        if (stamped != null) {
            return stamped;
        }
        if (restored) {
            return content.equals(savedContent) ? savedDelivery : null;
        }
        return fromHistory ? null : fresh;
    }

    /** What a share intent carries, without its delivery; null when it is not a share. */
    @SuppressWarnings("deprecation")
    static String contentSignature(Intent intent) {
        if (intent == null) {
            return null;
        }
        String action = intent.getAction();
        boolean multiple = Intent.ACTION_SEND_MULTIPLE.equals(action);
        if (!multiple && !Intent.ACTION_SEND.equals(action)) {
            return null;
        }
        // The activity is exported and accepts any type, so a malformed extra from another app
        // must not crash the main thread that asks for the signature.
        try {
            StringBuilder signature = new StringBuilder(action).append('|').append(intent.getType());
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text != null) {
                signature.append('|').append(text.hashCode());
            }
            if (multiple) {
                ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (streams != null) {
                    for (Uri stream : streams) {
                        signature.append('|').append(stream);
                    }
                }
            } else {
                Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (stream != null) {
                    signature.append('|').append(stream);
                }
            }
            return signature.toString();
        } catch (RuntimeException malformed) {
            return null;
        }
    }

    /**
     * Reads one share, or returns null when the intent carries none. It performs file I/O,
     * so the caller must run it off the main thread.
     */
    static SharedPayloadStore.SharedPayload read(Intent intent, ContentResolver resolver) {
        return read(intent, resolver, null);
    }

    /**
     * The same read, refusing URIs of this app's own FileProvider: a share hands over another
     * app's content, and an intent naming our own provider would attach this app's files.
     */
    static SharedPayloadStore.SharedPayload read(Intent intent, ContentResolver resolver, String ownPackage) {
        return read(intent, resolver, DEFAULT_READ_TIMEOUT_MS, DEFAULT_SHARE_DEADLINE_MS, ownPackage, null);
    }

    /** The same read, also refusing a URI the grant check denies, before any provider call. */
    static SharedPayloadStore.SharedPayload read(Intent intent, ContentResolver resolver, String ownPackage, ReadGrant grant) {
        return read(intent, resolver, DEFAULT_READ_TIMEOUT_MS, DEFAULT_SHARE_DEADLINE_MS, ownPackage, grant);
    }

    /** Per-file reads still running; tests check that stalled providers do not pile them up. */
    static int outstandingReads() {
        return outstandingReads.get();
    }

    /**
     * Whether a shared URI may be read at all: only a content:// URI, and never this app's own
     * FileProvider. The read also requires the sender's read grant ({@link ReadGrant}).
     */
    static boolean isExternalContent(Uri uri, String ownPackage) {
        if (uri == null || !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            return false;
        }
        return ownPackage == null || !(ownPackage + ".fileprovider").equals(uri.getAuthority());
    }

    /**
     * The same read with an explicit per-file timeout and whole-share deadline, so a test can
     * drive a stalled provider without waiting the production time out.
     */
    static SharedPayloadStore.SharedPayload read(
        Intent intent,
        ContentResolver resolver,
        long readTimeoutMs,
        long deadlineMs
    ) {
        return read(intent, resolver, readTimeoutMs, deadlineMs, null, null);
    }

    static SharedPayloadStore.SharedPayload read(
        Intent intent,
        ContentResolver resolver,
        long readTimeoutMs,
        long deadlineMs,
        String ownPackage,
        ReadGrant grant
    ) {
        if (intent == null) {
            return null;
        }
        String action = intent.getAction();
        boolean multiple = Intent.ACTION_SEND_MULTIPLE.equals(action);
        if (!multiple && !Intent.ACTION_SEND.equals(action)) {
            return null;
        }

        String text = readText(intent);
        List<Uri> streams = readStreams(intent, multiple);
        if (text == null && streams.isEmpty()) {
            return null;
        }

        List<SharedPayloadStore.FilePayload> files = new ArrayList<>();
        List<SharedPayloadStore.Rejection> rejected = new ArrayList<>();
        long batchBytes = 0;
        long deadline = System.nanoTime() + deadlineMs * 1_000_000L;

        for (int index = 0; index < streams.size(); index++) {
            Uri uri = streams.get(index);
            if (uri == null) {
                continue;
            }
            // Refusals that need nothing from the provider come first, so an extra item or a
            // URI this app must not read costs no provider I/O.
            if (index >= SharedPayloadStore.MAX_FILES) {
                rejected.add(new SharedPayloadStore.Rejection(fallbackName(uri), SharedPayloadStore.REASON_TOO_MANY));
                continue;
            }
            if (!isExternalContent(uri, ownPackage) || (grant != null && !grant.granted(uri))) {
                rejected.add(new SharedPayloadStore.Rejection(fallbackName(uri), SharedPayloadStore.REASON_UNREADABLE));
                continue;
            }

            long remainingMs = (deadline - System.nanoTime()) / 1_000_000L;
            if (remainingMs <= 0) {
                // The share took too long already; name the rest instead of reading on.
                rejected.add(new SharedPayloadStore.Rejection(fallbackName(uri), SharedPayloadStore.REASON_TIMED_OUT));
                continue;
            }

            // The calls before the bytes exist too (a provider's query and openFile are binder
            // round trips), so the whole per-file phase runs on a worker with a deadline.
            FileRead file = readFileWithin(resolver, uri, index, batchBytes, Math.min(readTimeoutMs, remainingMs));
            if (file.reason != null) {
                rejected.add(new SharedPayloadStore.Rejection(file.name, file.reason));
                continue;
            }
            // A provider may under-report SIZE, so the batch is checked against what was read.
            String refusal = SharedPayloadStore.rejectionReason(index, file.data.length, batchBytes, true, true);
            if (refusal != null) {
                rejected.add(new SharedPayloadStore.Rejection(file.name, refusal));
                continue;
            }

            files.add(new SharedPayloadStore.FilePayload(
                file.name,
                file.mimeType,
                Base64.encodeToString(file.data, Base64.NO_WRAP)
            ));
            batchBytes += file.data.length;
        }

        return new SharedPayloadStore.SharedPayload(signature(intent), text, files, rejected);
    }

    /**
     * Reads one shared file on its own thread and stops waiting at the deadline. A provider stuck
     * in a binder call cannot be interrupted, so the worker is abandoned rather than joined; it
     * is a daemon, and later shares are not queued behind it.
     */
    private static FileRead readFileWithin(
        ContentResolver resolver,
        Uri uri,
        int index,
        long batchBytes,
        long timeoutMs
    ) {
        if (outstandingReads.incrementAndGet() > MAX_OUTSTANDING_READS) {
            outstandingReads.decrementAndGet();
            return FileRead.failure(fallbackName(uri), SharedPayloadStore.REASON_TIMED_OUT);
        }
        AtomicReference<FileRead> result = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                result.set(readOne(resolver, uri, index, batchBytes, timeoutMs));
            } finally {
                outstandingReads.decrementAndGet();
            }
        }, "share-file-read");
        worker.setDaemon(true);
        worker.start();
        try {
            worker.join(timeoutMs);
            if (result.get() == null) {
                // The deadline fell while the worker was finishing; give it a moment before
                // reporting a file it may already have read.
                worker.join(500);
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        FileRead finished = result.get();
        return finished != null ? finished : FileRead.failure(fallbackName(uri), SharedPayloadStore.REASON_TIMED_OUT);
    }

    private static FileRead readOne(ContentResolver resolver, Uri uri, int index, long batchBytes, long timeoutMs) {
        Metadata metadata = readMetadata(resolver, uri);

        // Android accepts any shared type; the web layer's attachment rules filter.
        String refusal = SharedPayloadStore.rejectionReason(index, metadata.size, batchBytes, true, true);
        if (refusal != null) {
            return FileRead.failure(metadata.name, refusal);
        }

        ReadResult bytes = readBytes(resolver, uri, metadata.size, timeoutMs);
        if (bytes.reason != null) {
            // No name or URI: logcat is readable by more than this app on some devices.
            android.util.Log.i("SharedIntent", "Refused a shared file (" + bytes.reason
                + ", declared=" + metadata.size + ")");
            return FileRead.failure(metadata.name, bytes.reason);
        }
        return new FileRead(metadata.name, readMimeType(resolver, uri), bytes.data);
    }

    private static String fallbackName(Uri uri) {
        String name = uri.getLastPathSegment();
        return name == null || name.isEmpty() ? "file" : name;
    }

    private static String readText(Intent intent) {
        CharSequence raw = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (raw == null) {
            return null;
        }
        String text = raw.toString().trim();
        return text.isEmpty() ? null : text;
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> readStreams(Intent intent, boolean multiple) {
        if (multiple) {
            ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            return streams == null ? Collections.<Uri>emptyList() : new ArrayList<>(streams);
        }
        Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return stream == null ? Collections.<Uri>emptyList() : Collections.singletonList(stream);
    }

    private static Metadata readMetadata(ContentResolver resolver, Uri uri) {
        String name = null;
        long size = -1;
        String[] columns = { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
        try (Cursor cursor = resolver.query(uri, columns, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameColumn >= 0 && !cursor.isNull(nameColumn)) {
                    name = cursor.getString(nameColumn);
                }
                int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) {
                    size = cursor.getLong(sizeColumn);
                }
            }
        } catch (RuntimeException ignored) {
            // A provider may refuse the query; the URI and its stream can still work.
        }
        if (name == null || name.trim().isEmpty()) {
            name = uri.getLastPathSegment();
        }
        if (name == null || name.isEmpty()) {
            name = "file";
        }
        return new Metadata(name, size);
    }

    private static String readMimeType(ContentResolver resolver, Uri uri) {
        String type;
        try {
            type = resolver.getType(uri);
        } catch (RuntimeException ignored) {
            type = null;
        }
        return type == null || type.isEmpty() ? "application/octet-stream" : type;
    }

    /**
     * Reads the stream with the provider's declared size as the expected length: a stream that
     * ends early is a truncated file and is refused by name instead of being attached.
     */
    private static ReadResult readBytes(
        ContentResolver resolver,
        Uri uri,
        long declaredSize,
        long timeoutMs
    ) {
        InputStream stream = null;
        Thread watchdog = null;
        final AtomicBoolean timedOut = new AtomicBoolean(false);
        try {
            stream = resolver.openInputStream(uri);
            if (stream == null) {
                return ReadResult.failure(SharedPayloadStore.REASON_UNREADABLE);
            }

            // Android closes an input stream by signalling the threads blocked in it, so the
            // watchdog's close ends a read the provider never answers.
            final Closeable guarded = stream;
            watchdog = new Thread(() -> {
                try {
                    Thread.sleep(timeoutMs);
                } catch (InterruptedException interrupted) {
                    return;
                }
                timedOut.set(true);
                closeQuietly(guarded);
            }, "share-read-timeout");
            watchdog.setDaemon(true);
            watchdog.start();

            int initialSize = declaredSize > 0 && declaredSize <= SharedPayloadStore.MAX_FILE_BYTES
                ? (int) declaredSize
                : CHUNK_BYTES;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(initialSize);
            byte[] chunk = new byte[CHUNK_BYTES];
            long total = 0;
            int emptyReads = 0;
            int read;
            while ((read = stream.read(chunk)) != -1) {
                if (read == 0) {
                    // Some providers return 0 instead of blocking; do not spin forever on it.
                    if (++emptyReads >= MAX_EMPTY_READS) {
                        return ReadResult.failure(
                            timedOut.get() ? SharedPayloadStore.REASON_TIMED_OUT : SharedPayloadStore.REASON_UNREADABLE
                        );
                    }
                    continue;
                }
                emptyReads = 0;
                total += read;
                // Stop before a too-large file is held in memory in full.
                if (total > SharedPayloadStore.MAX_FILE_BYTES) {
                    return ReadResult.failure(SharedPayloadStore.REASON_TOO_LARGE);
                }
                buffer.write(chunk, 0, read);
            }
            if (timedOut.get()) {
                // The watchdog closed the stream, which can end the loop like a clean EOF; what
                // was read is a partial copy and must never be handed over.
                return ReadResult.failure(SharedPayloadStore.REASON_TIMED_OUT);
            }
            if (total == 0) {
                // An empty share cannot be attached, and the page's payload schema refuses an
                // empty file, so name it instead of sending something it would drop whole.
                return ReadResult.failure(SharedPayloadStore.REASON_UNREADABLE);
            }
            if (declaredSize > 0 && total != declaredSize) {
                // The provider promised a size the stream did not deliver, so the copy is
                // truncated and must not be attached as if it were the whole file.
                return ReadResult.failure(SharedPayloadStore.REASON_UNREADABLE);
            }
            return new ReadResult(buffer.toByteArray(), null);
        } catch (IOException | RuntimeException error) {
            android.util.Log.w("SharedIntent", "A shared file read failed: " + error.getClass().getSimpleName());
            return ReadResult.failure(
                timedOut.get() ? SharedPayloadStore.REASON_TIMED_OUT : SharedPayloadStore.REASON_UNREADABLE
            );
        } finally {
            if (watchdog != null) {
                watchdog.interrupt();
            }
            closeQuietly(stream);
        }
    }

    private static void closeQuietly(Closeable stream) {
        if (stream == null) {
            return;
        }
        try {
            stream.close();
        } catch (IOException ignored) {
            // Closing is the recovery path; a failure here changes nothing.
        }
    }

    private static final class FileRead {
        final String name;
        final String mimeType;
        final byte[] data;
        final String reason;

        FileRead(String name, String mimeType, byte[] data) {
            this.name = name;
            this.mimeType = mimeType;
            this.data = data;
            this.reason = null;
        }

        private FileRead(String name, String reason) {
            this.name = name;
            this.mimeType = null;
            this.data = null;
            this.reason = reason;
        }

        static FileRead failure(String name, String reason) {
            return new FileRead(name, reason);
        }
    }

    private static final class Metadata {
        final String name;
        final long size;

        Metadata(String name, long size) {
            this.name = name;
            this.size = size;
        }
    }

    private static final class ReadResult {
        final byte[] data;
        final String reason;

        ReadResult(byte[] data, String reason) {
            this.data = data;
            this.reason = reason;
        }

        static ReadResult failure(String reason) {
            return new ReadResult(null, reason);
        }
    }
}
