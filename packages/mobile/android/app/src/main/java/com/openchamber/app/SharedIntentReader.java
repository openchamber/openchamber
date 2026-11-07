package com.openchamber.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Turns a share intent into the payload SharedFiles.takePending hands to the page. */
final class SharedIntentReader {

    private static final int CHUNK_BYTES = 64 * 1024;

    private SharedIntentReader() {}

    /**
     * Reads one share, or returns null when the intent carries none. It performs file I/O,
     * so the caller must run it off the main thread.
     */
    static SharedPayloadStore.SharedPayload read(Intent intent, ContentResolver resolver) {
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

        for (int index = 0; index < streams.size(); index++) {
            Uri uri = streams.get(index);
            if (uri == null) {
                continue;
            }
            Metadata metadata = readMetadata(resolver, uri);

            // Android accepts any shared type; the web layer's attachment rules filter.
            String refusal = SharedPayloadStore.rejectionReason(index, metadata.size, batchBytes, true, true);
            if (refusal != null) {
                rejected.add(new SharedPayloadStore.Rejection(metadata.name, refusal));
                continue;
            }

            ReadResult result = readBytes(resolver, uri, metadata.size);
            if (result.reason != null) {
                rejected.add(new SharedPayloadStore.Rejection(metadata.name, result.reason));
                continue;
            }
            // A provider may under-report SIZE, so the batch is checked against what was read.
            refusal = SharedPayloadStore.rejectionReason(index, result.data.length, batchBytes, true, true);
            if (refusal != null) {
                rejected.add(new SharedPayloadStore.Rejection(metadata.name, refusal));
                continue;
            }

            String mimeType = readMimeType(resolver, uri);
            files.add(new SharedPayloadStore.FilePayload(
                metadata.name,
                mimeType,
                Base64.encodeToString(result.data, Base64.NO_WRAP)
            ));
            batchBytes += result.data.length;
        }

        return new SharedPayloadStore.SharedPayload(text, files, rejected);
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

    private static ReadResult readBytes(ContentResolver resolver, Uri uri, long declaredSize) {
        try (InputStream stream = resolver.openInputStream(uri)) {
            if (stream == null) {
                return ReadResult.failure(SharedPayloadStore.REASON_UNREADABLE);
            }
            int initialSize = declaredSize > 0 && declaredSize <= SharedPayloadStore.MAX_FILE_BYTES
                ? (int) declaredSize
                : CHUNK_BYTES;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(initialSize);
            byte[] chunk = new byte[CHUNK_BYTES];
            long total = 0;
            int read;
            while ((read = stream.read(chunk)) != -1) {
                total += read;
                // Stop before a too-large file is held in memory in full.
                if (total > SharedPayloadStore.MAX_FILE_BYTES) {
                    return ReadResult.failure(SharedPayloadStore.REASON_TOO_LARGE);
                }
                buffer.write(chunk, 0, read);
            }
            if (total == 0) {
                // An empty share cannot be attached, and the page's payload schema refuses an
                // empty file, so name it instead of sending something it would drop whole.
                return ReadResult.failure(SharedPayloadStore.REASON_UNREADABLE);
            }
            return new ReadResult(buffer.toByteArray(), null);
        } catch (IOException | RuntimeException error) {
            return ReadResult.failure(SharedPayloadStore.REASON_UNREADABLE);
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
