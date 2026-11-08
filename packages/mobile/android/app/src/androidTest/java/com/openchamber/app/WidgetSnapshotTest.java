package com.openchamber.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** The snapshot the page hands over is the widgets' only input, so its rules are the contract. */
@RunWith(AndroidJUnit4.class)
public class WidgetSnapshotTest {

    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.getSharedPreferences("openchamber_widget", Context.MODE_PRIVATE).edit().clear().commit();
    }

    private static final String SNAPSHOT =
        "{\"runtimeKey\":\"runtime-a\",\"attentionCount\":2,\"recentSessions\":["
            + "{\"id\":\"ses1\",\"title\":\"Fix the login flow\",\"unread\":true,\"project\":\"web\"},"
            + "{\"id\":\"ses2\",\"title\":\"\",\"unread\":false,\"project\":\"\"}]}";

    @Test
    public void roundTripsThePagesJson() {
        assertTrue(WidgetSnapshotStore.write(context, SNAPSHOT));

        WidgetSnapshot snapshot = WidgetSnapshotStore.read(context);
        assertEquals("runtime-a", snapshot.runtimeKey);
        assertEquals(2, snapshot.attentionCount);
        assertEquals(2, snapshot.recentSessions.size());
        assertEquals("Fix the login flow", snapshot.recentSessions.get(0).title);
        assertTrue(snapshot.recentSessions.get(0).unread);
        // An empty title is what the page sends for an untitled session; the widget supplies
        // the fallback copy.
        assertEquals("", snapshot.recentSessions.get(1).title);
        assertEquals("web", snapshot.recentSessions.get(0).project);
    }

    @Test
    public void ignoresAnUnchangedSnapshotSoWidgetsAreNotRepaintedNeedlessly() {
        assertTrue(WidgetSnapshotStore.write(context, SNAPSHOT));
        assertFalse(WidgetSnapshotStore.write(context, SNAPSHOT));
    }

    @Test
    public void keepsTheLastGoodSnapshotWhenThePageCouldNotBuildOne() {
        assertTrue(WidgetSnapshotStore.write(context, SNAPSHOT));
        // evaluateJavascript answers null while the page is still booting.
        assertFalse(WidgetSnapshotStore.write(context, null));
        assertFalse(WidgetSnapshotStore.write(context, "null"));
        assertEquals(2, WidgetSnapshotStore.read(context).attentionCount);
    }

    @Test
    public void rendersAnEmptyWidgetRatherThanThrowingOnMalformedJson() {
        context.getSharedPreferences("openchamber_widget", Context.MODE_PRIVATE).edit()
            .putString("widgetSnapshot", "{not json").commit();

        WidgetSnapshot snapshot = WidgetSnapshotStore.read(context);
        assertNull(snapshot.runtimeKey);
        assertEquals(0, snapshot.attentionCount);
        assertTrue(snapshot.recentSessions.isEmpty());
    }

    @Test
    public void aPushUpdatesTheCountAndMarksThatSessionUnread() {
        WidgetSnapshotStore.write(context, SNAPSHOT);

        assertTrue(WidgetSnapshotStore.applyPush(context, "runtime-a", 5, "ses2"));

        WidgetSnapshot snapshot = WidgetSnapshotStore.read(context);
        assertEquals(5, snapshot.attentionCount);
        assertTrue(snapshot.recentSessions.get(0).unread);
        assertTrue("the pushed session becomes unread", snapshot.recentSessions.get(1).unread);
        assertEquals("the pushed session is untouched", "Fix the login flow", snapshot.recentSessions.get(0).title);
    }

    @Test
    public void aPushFromAnotherServerReplacesTheSnapshot() {
        WidgetSnapshotStore.write(context, SNAPSHOT);

        assertTrue(WidgetSnapshotStore.applyPush(context, "runtime-b", 1, null));

        WidgetSnapshot snapshot = WidgetSnapshotStore.read(context);
        assertEquals("runtime-b", snapshot.runtimeKey);
        assertEquals(1, snapshot.attentionCount);
        assertTrue("sessions from the other server must not be shown", snapshot.recentSessions.isEmpty());
    }
}
