package com.openchamber.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Runs the share intake on a device against the real Android framework: a real
 * {@link ContentResolver}, a real provider serving a {@code content://} URI, real files and a
 * real pipe. Nothing here stands in for {@link SharedIntentReader} — the intent it is given is
 * shaped exactly the way another app's share builds one.
 */
@RunWith(AndroidJUnit4.class)
public class SharedIntentReaderTest {

    private ContentResolver resolver;
    private final byte[] photoBytes = new byte[] { (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };

    @Before
    public void setUp() {
        resolver = InstrumentationRegistry.getInstrumentation().getTargetContext().getContentResolver();
        TestFilesProvider.clear();
        SharedPayloadStore.take();
    }

    private static Intent send(String action) {
        return new Intent(action).addCategory(Intent.CATEGORY_DEFAULT);
    }

    private static String describe(SharedPayloadStore.SharedPayload payload) {
        StringBuilder text = new StringBuilder("rejected[");
        for (SharedPayloadStore.Rejection rejection : payload.rejected) {
            text.append(rejection.name).append('=').append(rejection.reason).append(' ');
        }
        return text.append("]").toString();
    }

    /** The provider first: if this fails, the reader is not what is broken. */
    @Test
    public void theProviderServesAByteForByteCopy() throws Exception {
        Uri uri = TestFilesProvider.addFile("IMG_0002.JPG", "image/jpeg", photoBytes);

        byte[] served = new byte[photoBytes.length];
        int read = resolver.openInputStream(uri).read(served);

        assertEquals(photoBytes.length, read);
        assertArrayEquals(photoBytes, served);
        assertEquals("image/jpeg", resolver.getType(uri));
    }

    @Test
    public void readsATextShare() {
        Intent intent = send(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Summarise this thread");

        SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver);

        assertNotNull(payload);
        assertEquals("Summarise this thread", payload.text);
        assertEquals(0, payload.files.size());
        assertEquals(0, payload.rejected.size());
    }

    @Test
    public void blankTextIsNotAShare() {
        Intent intent = send(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "   \n ");

        assertNull(SharedIntentReader.read(intent, resolver));
    }

    @Test
    public void readsASingleSharedFile() {
        Uri uri = TestFilesProvider.addFile("IMG_0002.JPG", "image/jpeg", photoBytes);
        Intent intent = send(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM, uri);

        SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver);

        assertNotNull(payload);
        assertNull(payload.text);
        assertEquals(describe(payload), 1, payload.files.size());
        assertEquals("IMG_0002.JPG", payload.files.get(0).name);
        assertEquals("image/jpeg", payload.files.get(0).mimeType);
        assertArrayEquals(photoBytes, Base64.decode(payload.files.get(0).data, Base64.NO_WRAP));
    }

    @Test
    public void readsTextAndAFileTogether() {
        Uri uri = TestFilesProvider.addFile("shot.png", "image/png", photoBytes);
        Intent intent = send(Intent.ACTION_SEND)
            .setType("image/png")
            .putExtra(Intent.EXTRA_TEXT, "Screenshot of the failing test")
            .putExtra(Intent.EXTRA_STREAM, uri);

        SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver);

        assertNotNull(payload);
        assertEquals("Screenshot of the failing test", payload.text);
        assertEquals(1, payload.files.size());
    }

    @Test
    public void readsAMultipleShare() {
        Intent intent = send(Intent.ACTION_SEND_MULTIPLE).setType("image/png");
        ArrayList<Uri> streams = new ArrayList<>();
        for (int index = 0; index < 3; index++) {
            streams.add(TestFilesProvider.addFile("photo-" + index + ".png", "image/png", photoBytes));
        }
        intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, streams);

        SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver);

        assertNotNull(payload);
        assertEquals(3, payload.files.size());
        assertEquals("photo-0.png", payload.files.get(0).name);
        assertEquals("photo-2.png", payload.files.get(2).name);
    }

    @Test
    public void refusesTheNinthFileAndKeepsTheFirstEight() {
        Intent intent = send(Intent.ACTION_SEND_MULTIPLE).setType("image/png");
        ArrayList<Uri> streams = new ArrayList<>();
        for (int index = 0; index < 9; index++) {
            streams.add(TestFilesProvider.addFile("photo-" + index + ".png", "image/png", photoBytes));
        }
        intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, streams);

        SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver);

        assertNotNull(payload);
        assertEquals(SharedPayloadStore.MAX_FILES, payload.files.size());
        assertEquals(1, payload.rejected.size());
        assertEquals("too-many", payload.rejected.get(0).reason);
        assertEquals("photo-8.png", payload.rejected.get(0).name);
    }

    @Test
    public void refusesAFileOverTheLimitBeforeReadingItAll() {
        Uri uri = TestFilesProvider.addStream("huge.bin", "application/octet-stream", 26L * 1024 * 1024, true);
        Intent intent = send(Intent.ACTION_SEND).setType("application/octet-stream").putExtra(Intent.EXTRA_STREAM, uri);

        SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver);

        assertNotNull(payload);
        assertEquals(0, payload.files.size());
        assertEquals(1, payload.rejected.size());
        assertEquals("too-large", payload.rejected.get(0).reason);
    }

    @Test
    public void refusesAnUndeclaredOversizedStreamWhileItStreams() {
        // No declared size, so the cap has to be applied as the bytes arrive.
        Uri uri = TestFilesProvider.addStream("streamed.bin", "application/octet-stream", 26L * 1024 * 1024, false);
        Intent intent = send(Intent.ACTION_SEND).setType("application/octet-stream").putExtra(Intent.EXTRA_STREAM, uri);

        SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver);

        assertNotNull(payload);
        assertEquals(0, payload.files.size());
        assertEquals("too-large", payload.rejected.get(0).reason);
    }

    @Test
    public void refusesAnEmptyFileByName() {
        Uri uri = TestFilesProvider.addFile("empty.txt", "text/plain", new byte[0]);
        Intent intent = send(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM, uri);

        SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver);

        assertNotNull(payload);
        assertEquals(0, payload.files.size());
        assertEquals("empty.txt", payload.rejected.get(0).name);
        assertEquals("unreadable", payload.rejected.get(0).reason);
    }

    @Test
    public void ignoresALaunchThatIsNotAShare() {
        assertNull(SharedIntentReader.read(new Intent(Intent.ACTION_MAIN), resolver));
        assertNull(SharedIntentReader.read(null, resolver));
    }

    @Test
    public void handsThePayloadOverOnce() {
        Uri uri = TestFilesProvider.addFile("IMG_0002.JPG", "image/jpeg", photoBytes);
        Intent intent = send(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM, uri);
        SharedPayloadStore.put(SharedIntentReader.read(intent, resolver));

        SharedPayloadStore.SharedPayload first = SharedPayloadStore.take();

        assertNotNull(first);
        assertEquals(1, first.files.size());
        assertNull(SharedPayloadStore.take());
    }

    /**
     * The claim the manifest actually makes: another app sharing text or a file sees this app in
     * its share sheet. Asserted against the package manager rather than the manifest source.
     */
    @Test
    public void theAppIsOfferedByTheSystemShareSheet() {
        for (String mimeType : new String[] { "text/plain", "image/jpeg", "application/pdf", "application/octet-stream" }) {
            for (String action : new String[] { Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE }) {
                Intent share = new Intent(action).setType(mimeType).addCategory(Intent.CATEGORY_DEFAULT);
                String self = InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName();
                List<ResolveInfo> matches = InstrumentationRegistry.getInstrumentation()
                    .getTargetContext()
                    .getPackageManager()
                    .queryIntentActivities(share, 0);
                boolean offered = matches.stream().anyMatch(match -> self.equals(match.activityInfo.packageName));
                assertTrue("share sheet has no entry for " + action + " " + mimeType, offered);
            }
        }
    }
}
