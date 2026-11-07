package com.openchamber.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A real content provider for the share tests, registered through ProviderTestRule. It serves
 * what another app would hand over through a {@code content://} URI: a display name, a declared
 * size (or none, like providers that only stream), a MIME type and the bytes.
 *
 * <p>The bytes come from a file or from a pipe, so the oversized case can hand the reader 26 MB
 * it never stores, which is the case the size cap exists for.
 */
public class TestFilesProvider extends ContentProvider {

    public static final String AUTHORITY = "com.openchamber.app.testfiles";
    private static final Uri BASE = Uri.parse("content://" + AUTHORITY + "/");

    private static final Map<String, Fixture> FIXTURES = new ConcurrentHashMap<>();

    /** One shared file: either {@code bytes} or a {@code pipeBytes} stream. */
    public static final class Fixture {
        final String name;
        final String mimeType;
        final byte[] bytes;
        final long pipeBytes;
        final boolean reportSize;

        private Fixture(String name, String mimeType, byte[] bytes, long pipeBytes, boolean reportSize) {
            this.name = name;
            this.mimeType = mimeType;
            this.bytes = bytes;
            this.pipeBytes = pipeBytes;
            this.reportSize = reportSize;
        }
    }

    /** A file whose size the provider declares, the way a photo provider does. */
    public static Uri addFile(String name, String mimeType, byte[] bytes) {
        return add(new Fixture(name, mimeType, bytes, 0, true));
    }

    /** A stream whose size the provider does not declare; the reader has to count. */
    public static Uri addStream(String name, String mimeType, long bytes, boolean reportSize) {
        return add(new Fixture(name, mimeType, null, bytes, reportSize));
    }

    private static Uri add(Fixture fixture) {
        String path = UUID.randomUUID().toString();
        FIXTURES.put(path, fixture);
        return BASE.buildUpon().appendPath(path).build();
    }

    public static void clear() {
        FIXTURES.clear();
    }

    private static Fixture fixture(Uri uri) {
        return FIXTURES.get(uri.getLastPathSegment());
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        Fixture fixture = fixture(uri);
        if (fixture == null) {
            return null;
        }
        MatrixCursor cursor = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
        if (fixture.reportSize) {
            cursor.addRow(new Object[] { fixture.name, fixture.pipeBytes > 0 ? fixture.pipeBytes : fixture.bytes.length });
        } else {
            cursor.addRow(new Object[] { fixture.name, null });
        }
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        Fixture fixture = fixture(uri);
        return fixture == null ? null : fixture.mimeType;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) {
        Fixture fixture = fixture(uri);
        if (fixture == null) {
            return null;
        }
        if (fixture.bytes != null) {
            return fileDescriptor(fixture.bytes);
        }
        return pipe(fixture.pipeBytes);
    }

    private ParcelFileDescriptor fileDescriptor(byte[] bytes) {
        try {
            File file = new File(getContext().getCacheDir(), UUID.randomUUID().toString());
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
        } catch (IOException error) {
            return null;
        }
    }

    /**
     * Feeds the reader from a pipe so a stream far larger than the cap exists without ever being
     * stored. The writer ends early, with the reader closing the read end once it refuses.
     */
    private ParcelFileDescriptor pipe(long bytes) {
        try {
            ParcelFileDescriptor[] ends = ParcelFileDescriptor.createPipe();
            ParcelFileDescriptor writeEnd = ends[1];
            Thread writer = new Thread(() -> {
                byte[] chunk = new byte[64 * 1024];
                try (FileOutputStream out = new FileOutputStream(writeEnd.getFileDescriptor())) {
                    for (long written = 0; written < bytes; written += chunk.length) {
                        out.write(chunk, 0, (int) Math.min(chunk.length, bytes - written));
                    }
                } catch (IOException ignored) {
                    // The reader closes its end as soon as it has more than it accepts.
                }
            }, "testfiles-pipe");
            writer.setDaemon(true);
            writer.start();
            return ends[0];
        } catch (IOException error) {
            return null;
        }
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only provider");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only provider");
    }
}
