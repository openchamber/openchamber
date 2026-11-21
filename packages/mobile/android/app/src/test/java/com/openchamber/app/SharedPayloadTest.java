package com.openchamber.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Before;
import org.junit.Test;

public class SharedPayloadTest {

    @Before
    public void resetStore() {
        SharedPayloadStore.reset();
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
    public void takeHandsOverUntilAccepted() {
        SharedPayloadStore.put(read("A"));
        assertNotNull(SharedPayloadStore.take());
        assertNotNull(SharedPayloadStore.take());
        SharedPayloadStore.accept("A");
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

    private static SharedPayloadStore.SharedPayload read(String signature) {
        return new SharedPayloadStore.SharedPayload(signature, "share", null, null);
    }

    private static void recreateAfterProcessDeath() {
        java.util.ArrayList<String> saved = SharedPayloadStore.settledSignatures();
        SharedPayloadStore.reset();
        SharedPayloadStore.restoreSettled(saved);
    }

    @Test
    public void aQueuedShareIsNotReadTwiceButIsNotDoneEither() {
        assertTrue(SharedPayloadStore.claim("A"));
        assertFalse(SharedPayloadStore.claim("A"));
        assertTrue(SharedPayloadStore.settledSignatures().isEmpty());
    }

    @Test
    public void aWaitingShareIsNotReadAgainBeforeThePageTakesIt() {
        assertTrue(SharedPayloadStore.claim("A"));
        SharedPayloadStore.put(read("A"));
        assertFalse(SharedPayloadStore.claim("A"));
    }

    @Test
    public void aShareTheProcessLostBeforeThePageTookItIsReadAgain() {
        assertTrue(SharedPayloadStore.claim("A"));
        recreateAfterProcessDeath();
        assertTrue(SharedPayloadStore.claim("A"));

        SharedPayloadStore.put(read("A"));
        recreateAfterProcessDeath();
        assertTrue(SharedPayloadStore.claim("A"));
    }

    @Test
    public void aShareThePageAcceptedIsNeverReplayed() {
        assertTrue(SharedPayloadStore.claim("A"));
        SharedPayloadStore.put(read("A"));
        assertNotNull(SharedPayloadStore.take());
        SharedPayloadStore.accept("A");
        assertNull(SharedPayloadStore.take());
        assertFalse(SharedPayloadStore.claim("A"));
        recreateAfterProcessDeath();
        assertFalse(SharedPayloadStore.claim("A"));
    }

    @Test
    public void aShareThePageTookButDidNotAcceptIsHandedOverAgain() {
        assertTrue(SharedPayloadStore.claim("A"));
        SharedPayloadStore.put(read("A"));
        assertNotNull(SharedPayloadStore.take());
        // The page is recreated before its draft holds the share: the new page takes it again.
        assertEquals("A", SharedPayloadStore.take().signature);
        assertFalse("a waiting share was read again", SharedPayloadStore.claim("A"));
        // The process dies instead: the share was not done, so the restored intent reads it again.
        recreateAfterProcessDeath();
        assertTrue(SharedPayloadStore.claim("A"));
    }

    @Test
    public void acceptingAnOlderShareKeepsTheNewerOneWaiting() {
        SharedPayloadStore.claim("A");
        SharedPayloadStore.put(read("A"));
        SharedPayloadStore.claim("B");
        SharedPayloadStore.put(read("B"));
        SharedPayloadStore.accept("A");
        assertEquals("B", SharedPayloadStore.take().signature);
    }

    @Test
    public void twoDeliveriesOfTheSameContentAreTwoShares() {
        String first = "send|text/plain|42|delivery=1";
        String second = "send|text/plain|42|delivery=2";
        assertTrue(SharedPayloadStore.claim(first));
        SharedPayloadStore.put(read(first));
        SharedPayloadStore.accept(first);
        assertTrue("the same link shared again was dropped", SharedPayloadStore.claim(second));
        assertFalse("the first delivery was replayed", SharedPayloadStore.claim(first));
    }

    @Test
    public void aLaunchIntentGetsANewDeliveryOnlyWhenItIsANewShare() {
        // A cold start with a share is a new delivery.
        assertEquals("fresh", SharedIntentReader.launchDelivery("X", null, false, null, null, false, "fresh"));
        // A launch from recents replays an old intent.
        assertNull(SharedIntentReader.launchDelivery("X", null, false, null, null, true, "fresh"));
        // A recreation keeps the delivery the intent already carries.
        assertEquals("d1", SharedIntentReader.launchDelivery("X", "d1", true, "X", "d2", false, "fresh"));
        // A restored activity reads its last share under the saved delivery, even when an
        // earlier share had the same content.
        assertEquals("d2", SharedIntentReader.launchDelivery("X", null, true, "X", "d2", false, "fresh"));
        // An older intent it comes back with was settled or replaced when the newer one arrived.
        assertNull(SharedIntentReader.launchDelivery("Y", null, true, "X", "d2", false, "fresh"));
        assertNull(SharedIntentReader.launchDelivery("X", null, true, null, null, false, "fresh"));
        assertNull(SharedIntentReader.launchDelivery(null, null, false, null, null, false, "fresh"));
    }

    @Test
    public void theLaunchShareStaysDoneAfterLaterSharesAreAccepted() {
        for (String signature : new String[] { "launch", "B", "C" }) {
            assertTrue(SharedPayloadStore.claim(signature));
            SharedPayloadStore.put(read(signature));
            SharedPayloadStore.accept(signature);
        }
        recreateAfterProcessDeath();
        assertFalse(SharedPayloadStore.claim("launch"));
    }

    @Test
    public void aShareReplacedBeforeThePageReadItIsDone() {
        SharedPayloadStore.claim("A");
        SharedPayloadStore.put(read("A"));
        SharedPayloadStore.claim("B");
        SharedPayloadStore.put(read("B"));
        recreateAfterProcessDeath();
        assertFalse(SharedPayloadStore.claim("A"));
        assertTrue(SharedPayloadStore.claim("B"));
    }

    @Test
    public void aQueuedShareANewerOneDisplacedIsDone() {
        SharedPayloadStore.claim("A");
        SharedPayloadStore.supersede("A");
        assertFalse(SharedPayloadStore.claim("A"));
    }

    @Test
    public void aReadThatProducedNothingCanBeTriedAgain() {
        SharedPayloadStore.claim("A");
        SharedPayloadStore.release("A");
        assertTrue(SharedPayloadStore.claim("A"));
    }

    @Test
    public void rememberedSharesAreBounded() {
        for (int index = 0; index < SharedPayloadStore.MAX_SETTLED + 5; index++) {
            SharedPayloadStore.supersede("share-" + index);
        }
        assertEquals(SharedPayloadStore.MAX_SETTLED, SharedPayloadStore.settledSignatures().size());
        assertFalse(SharedPayloadStore.claim("share-" + (SharedPayloadStore.MAX_SETTLED + 4)));
    }

    @Test
    public void aMissingSignatureIsNeverClaimed() {
        assertFalse(SharedPayloadStore.claim(null));
    }

    @Test
    public void emptyPayloadHasEmptyLists() {
        SharedPayloadStore.SharedPayload payload = SharedPayloadStore.SharedPayload.EMPTY;
        assertNull(payload.text);
        assertEquals(0, payload.files.size());
        assertEquals(0, payload.rejected.size());
    }
}
