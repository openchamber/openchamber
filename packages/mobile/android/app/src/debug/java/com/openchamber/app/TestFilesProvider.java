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
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

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
    // Write ends of the stalled pipes, held open so a reading test blocks instead of seeing EOF.
    private static final List<ParcelFileDescriptor> OPEN_PIPES = Collections.synchronizedList(new ArrayList<>());
    // Every query, getType and openFile, per fixture, so a test can assert a file was never asked for.
    private static final Map<String, AtomicInteger> ACCESSES = new ConcurrentHashMap<>();
    // Holds openFile for blocked fixtures until clear(), like a provider stuck in a binder call.
    private static volatile CountDownLatch release = new CountDownLatch(1);

    /** One shared file: {@code bytes}, a {@code pipeBytes} stream, or a pipe that never writes. */
    public static final class Fixture {
        final String name;
        final String mimeType;
        final byte[] bytes;
        final long pipeBytes;
        final boolean reportSize;
        /** What the provider claims in SIZE; -1 means the length it actually serves. */
        final long declaredSize;
        final boolean stalled;
        /** openFile itself blocks until {@link #clear()}: stuck before the first byte. */
        boolean blockOpen;

        private Fixture(
            String name,
            String mimeType,
            byte[] bytes,
            long pipeBytes,
            boolean reportSize,
            long declaredSize,
            boolean stalled
        ) {
            this.name = name;
            this.mimeType = mimeType;
            this.bytes = bytes;
            this.pipeBytes = pipeBytes;
            this.reportSize = reportSize;
            this.declaredSize = declaredSize;
            this.stalled = stalled;
        }
    }

    /** A file whose size the provider declares, the way a photo provider does. */
    public static Uri addFile(String name, String mimeType, byte[] bytes) {
        return add(new Fixture(name, mimeType, bytes, 0, true, -1, false));
    }

    /** A file that serves fewer bytes than its declared SIZE, the way a truncated copy does. */
    public static Uri addTruncated(String name, String mimeType, byte[] bytes, long declaredSize) {
        return add(new Fixture(name, mimeType, bytes, 0, true, declaredSize, false));
    }

    /** A stream whose size the provider does not declare; the reader has to count. */
    public static Uri addStream(String name, String mimeType, long bytes, boolean reportSize) {
        return add(new Fixture(name, mimeType, null, bytes, reportSize, -1, false));
    }

    /** A stream whose provider accepts the read and then never serves a byte. */
    public static Uri addStalled(String name, String mimeType) {
        return add(new Fixture(name, mimeType, null, 0, false, -1, true));
    }

    /** A provider whose openFile never returns until {@link #clear()}. */
    public static Uri addBlockedOpen(String name, String mimeType) {
        Fixture fixture = new Fixture(name, mimeType, null, 0, false, -1, true);
        fixture.blockOpen = true;
        return add(fixture);
    }

    /** A stream that serves {@code bytes}, then never another byte and never ends. */
    public static Uri addStalledAfter(String name, String mimeType, byte[] bytes) {
        return add(new Fixture(name, mimeType, bytes, 0, false, -1, true));
    }

    /** How often the reader asked this provider anything about {@code uri}. */
    public static int accesses(Uri uri) {
        AtomicInteger count = ACCESSES.get(uri.getLastPathSegment());
        return count == null ? 0 : count.get();
    }

    private static Uri add(Fixture fixture) {
        String path = UUID.randomUUID().toString();
        FIXTURES.put(path, fixture);
        return BASE.buildUpon().appendPath(path).build();
    }

    public static void clear() {
        FIXTURES.clear();
        ACCESSES.clear();
        CountDownLatch blocked = release;
        release = new CountDownLatch(1);
        blocked.countDown();
        synchronized (OPEN_PIPES) {
            for (ParcelFileDescriptor pipe : OPEN_PIPES) {
                try {
                    pipe.close();
                } catch (IOException ignored) {
                    // A closed write end is what the next clear wants anyway.
                }
            }
            OPEN_PIPES.clear();
        }
    }

    private static Fixture fixture(Uri uri) {
        String path = uri.getLastPathSegment();
        if (path != null) {
            ACCESSES.computeIfAbsent(path, key -> new AtomicInteger()).incrementAndGet();
        }
        return FIXTURES.get(path);
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
            long served = fixture.pipeBytes > 0 ? fixture.pipeBytes : fixture.bytes.length;
            cursor.addRow(new Object[] { fixture.name, fixture.declaredSize >= 0 ? fixture.declaredSize : served });
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
        if (fixture.blockOpen) {
            try {
                release.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return null;
        }
        if (fixture.stalled) {
            return stalledPipe(fixture.bytes);
        }
        if (fixture.bytes != null) {
            return fileDescriptor(fixture.bytes);
        }
        return pipe(fixture.pipeBytes);
    }

    /**
     * A read end that serves {@code prefix} (or nothing) and then stalls; the write end stays open
     * until {@link #clear()}.
     */
    private ParcelFileDescriptor stalledPipe(byte[] prefix) {
        try {
            ParcelFileDescriptor[] ends = ParcelFileDescriptor.createPipe();
            OPEN_PIPES.add(ends[1]);
            if (prefix != null && prefix.length > 0) {
                // Small enough for the pipe buffer, so this write does not block.
                new FileOutputStream(ends[1].getFileDescriptor()).write(prefix);
            }
            return ends[0];
        } catch (IOException error) {
            return null;
        }
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
