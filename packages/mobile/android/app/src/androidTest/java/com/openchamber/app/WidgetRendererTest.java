package com.openchamber.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RemoteViews;
import android.widget.TextView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Inflates the real layouts. A RemoteViews layout error only shows up on a device, and a widget
 * that fails to inflate shows the launcher's "problem loading widget" instead of the app.
 */
@RunWith(AndroidJUnit4.class)
public class WidgetRendererTest {

    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private View apply(RemoteViews views) throws Exception {
        AtomicReference<View> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            FrameLayout parent = new FrameLayout(context);
            result.set(views.apply(context, parent));
            done.countDown();
        });
        assertTrue("inflation did not finish", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    private static WidgetSnapshot snapshot(int attention, String... titles) {
        StringBuilder json = new StringBuilder("{\"runtimeKey\":\"r\",\"attentionCount\":")
            .append(attention)
            .append(",\"recentSessions\":[");
        for (int index = 0; index < titles.length; index++) {
            if (index > 0) {
                json.append(',');
            }
            json.append("{\"id\":\"s")
                .append(index)
                .append("\",\"title\":\"")
                .append(titles[index])
                .append("\",\"unread\":")
                .append(index == 0)
                .append(",\"project\":\"app\"}");
        }
        return WidgetSnapshot.parse(json.append("]}").toString());
    }

    private static String text(View root, int id) {
        TextView view = root.findViewById(id);
        return view == null ? null : view.getText().toString();
    }

    @Test
    public void theSessionsWidgetListsEveryStoredSession() throws Exception {
        WidgetSnapshot data = snapshot(2, "Fix login", "Ship the widget", "Review PR");

        View view = apply(WidgetRenderer.sessions(context, data));

        assertEquals("Fix login", text(view, R.id.r1_title));
        assertEquals("Ship the widget", text(view, R.id.r2_title));
        assertEquals("Review PR", text(view, R.id.r3_title));
        assertEquals(View.GONE, view.findViewById(R.id.r4).getVisibility());
        assertEquals("2", text(view, R.id.widget_attention));
        assertEquals("app", text(view, R.id.r1_project));
    }

    @Test
    public void anEmptySessionListShowsTheEmptyState() throws Exception {
        View view = apply(WidgetRenderer.sessions(context, snapshot(0)));

        assertEquals(View.VISIBLE, view.findViewById(R.id.widget_empty).getVisibility());
        assertEquals(View.GONE, view.findViewById(R.id.r1).getVisibility());
        assertEquals("", text(view, R.id.widget_attention));
    }

    @Test
    public void theOverviewWidgetCapsTheListAtThreeRows() throws Exception {
        View view = apply(WidgetRenderer.overview(context, snapshot(1, "One", "Two", "Three", "Four")));

        assertEquals("One", text(view, R.id.r1_title));
        assertEquals("Three", text(view, R.id.r3_title));
        // The overview layout declares three rows, so a fourth session simply has no view.
        assertTrue("the overview must not grow a fourth row", view.findViewById(R.id.r4) == null);
        assertEquals("1", text(view, R.id.widget_attention));
    }

    @Test
    public void theQuickActionsWidgetShowsTheCountAndStaysInflatable() throws Exception {
        View view = apply(WidgetRenderer.quickActions(context, snapshot(3)));

        assertEquals("3 need attention", text(view, R.id.widget_attention));
        assertTrue(view.findViewById(R.id.quick_new) instanceof TextView);
        assertTrue(view.findViewById(R.id.quick_attention) instanceof TextView);
    }

    @Test
    public void theNewSessionTileInflates() throws Exception {
        View view = apply(WidgetRenderer.newSession(context));

        assertTrue(view instanceof LinearLayout);
        assertTrue(view.findViewById(R.id.new_session_root) != null);
    }
}
