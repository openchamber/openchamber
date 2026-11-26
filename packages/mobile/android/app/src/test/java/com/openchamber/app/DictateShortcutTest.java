package com.openchamber.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Before;
import org.junit.Test;

public class DictateShortcutTest {

    @Before
    public void resetInbox() {
        DictateShortcut.reset();
    }

    @Test
    public void onlyTheUnexportedAliasStartsDictation() {
        assertTrue(DictateShortcut.isRequest(DictateShortcut.ALIAS, false, false));
        // Another app can address MainActivity directly, with any action or extra.
        assertFalse(DictateShortcut.isRequest(MainActivity.class.getName(), false, false));
        assertFalse(DictateShortcut.isRequest(null, false, false));
    }

    @Test
    public void aRelaunchOrRestoreOfTheShortcutIntentDoesNotRecordAgain() {
        assertFalse(DictateShortcut.isRequest(DictateShortcut.ALIAS, true, false));
        assertFalse(DictateShortcut.isRequest(DictateShortcut.ALIAS, false, true));
    }

    @Test
    public void aRequestIsHandedOutOnce() {
        assertFalse(DictateShortcut.take());
        DictateShortcut.deliver();
        assertTrue(DictateShortcut.take());
        assertFalse(DictateShortcut.take());
    }

    @Test
    public void aRequestBeforeThePageLoadsWaitsAndALiveOneIsAnnounced() {
        DictateShortcut.deliver();
        AtomicInteger announced = new AtomicInteger();
        DictateShortcut.Listener listener = announced::incrementAndGet;
        DictateShortcut.setListener(listener);
        assertTrue(DictateShortcut.take());

        DictateShortcut.deliver();
        assertEquals(1, announced.get());
        DictateShortcut.clearListener(listener);
        DictateShortcut.deliver();
        assertEquals(1, announced.get());
        assertTrue(DictateShortcut.take());
    }
}
