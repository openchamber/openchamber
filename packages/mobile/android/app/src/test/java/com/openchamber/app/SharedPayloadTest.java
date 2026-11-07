package com.openchamber.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Before;
import org.junit.Test;

public class SharedPayloadTest {

    @Before
    public void resetStore() {
        SharedPayloadStore.take();
        SharedPayloadStore.setListener(null);
    }

    @Test
    public void acceptsFileWithinEveryLimit() {
        assertNull(SharedPayloadStore.rejectionReason(0, 1024, 0, true, true));
    }

    @Test
    public void acceptsEighthFileButRefusesNinthAsTooMany() {
        assertNull(SharedPayloadStore.rejectionReason(7, 1024, 0, true, true));
        assertEquals("too-many", SharedPayloadStore.rejectionReason(8, 0, 0, true, true));
    }

    @Test
    public void refusesFileOverPerFileLimit() {
        assertEquals(
            "too-large",
            SharedPayloadStore.rejectionReason(0, SharedPayloadStore.MAX_FILE_BYTES + 1, 0, true, true)
        );
    }

    @Test
    public void acceptsFileAtPerFileLimit() {
        assertNull(
            SharedPayloadStore.rejectionReason(0, SharedPayloadStore.MAX_FILE_BYTES, 0, true, true)
        );
    }

    @Test
    public void refusesFileThatWouldExceedBatchLimit() {
        long batch = SharedPayloadStore.MAX_BATCH_BYTES - SharedPayloadStore.MAX_FILE_BYTES + 1;
        assertEquals(
            "batch-limit",
            SharedPayloadStore.rejectionReason(1, SharedPayloadStore.MAX_FILE_BYTES, batch, true, true)
        );
    }

    @Test
    public void acceptsFileThatExactlyFillsBatch() {
        long batch = SharedPayloadStore.MAX_BATCH_BYTES - SharedPayloadStore.MAX_FILE_BYTES;
        assertNull(
            SharedPayloadStore.rejectionReason(1, SharedPayloadStore.MAX_FILE_BYTES, batch, true, true)
        );
    }

    @Test
    public void refusesUnsupportedType() {
        assertEquals("unsupported-type", SharedPayloadStore.rejectionReason(0, 1024, 0, false, true));
    }

    @Test
    public void refusesUnreadableStream() {
        assertEquals("unreadable", SharedPayloadStore.rejectionReason(0, 1024, 0, true, false));
    }

    @Test
    public void tooManyWinsOverEveryOtherRefusal() {
        assertEquals(
            "too-many",
            SharedPayloadStore.rejectionReason(
                8,
                SharedPayloadStore.MAX_FILE_BYTES + 1,
                0,
                false,
                false
            )
        );
    }

    @Test
    public void newestShareReplacesThePendingOne() {
        SharedPayloadStore.SharedPayload first = new SharedPayloadStore.SharedPayload("first", null, null);
        SharedPayloadStore.SharedPayload second = new SharedPayloadStore.SharedPayload("second", null, null);
        SharedPayloadStore.put(first);
        SharedPayloadStore.put(second);
        assertSame(second, SharedPayloadStore.take());
    }

    @Test
    public void takeIsOnceOnly() {
        SharedPayloadStore.put(new SharedPayloadStore.SharedPayload("share", null, null));
        assertNotNull(SharedPayloadStore.take());
        assertNull(SharedPayloadStore.take());
    }

    @Test
    public void putNotifiesTheListener() {
        AtomicInteger notifications = new AtomicInteger();
        SharedPayloadStore.setListener(notifications::incrementAndGet);
        SharedPayloadStore.put(new SharedPayloadStore.SharedPayload("share", null, null));
        assertEquals(1, notifications.get());
    }

    @Test
    public void takeDoesNotNotify() {
        AtomicInteger notifications = new AtomicInteger();
        SharedPayloadStore.setListener(notifications::incrementAndGet);
        SharedPayloadStore.put(new SharedPayloadStore.SharedPayload("share", null, null));
        SharedPayloadStore.take();
        assertEquals(1, notifications.get());
    }

    @Test
    public void emptyPayloadHasEmptyLists() {
        SharedPayloadStore.SharedPayload payload = SharedPayloadStore.SharedPayload.EMPTY;
        assertNull(payload.text);
        assertEquals(0, payload.files.size());
        assertEquals(0, payload.rejected.size());
    }
}
