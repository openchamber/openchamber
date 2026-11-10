package com.openchamber.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.net.Uri;
import android.provider.MediaStore;
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
    public void theQuickActionsFitTheirSmallestCell() throws Exception {
        View view = apply(WidgetRenderer.quickActions(context, snapshot(4, "Fix login", "Ship it")));
        layoutAt(view, 110, 110);

        TextView newSession = view.findViewById(R.id.quick_new);
        TextView attention = view.findViewById(R.id.quick_attention);
        // A label that wraps here breaks mid-word on a real 2x2 cell, which is how it looked before.
        assertEquals("New session must stay on one line", 1, newSession.getLayout().getLineCount());
        assertEquals("Attention must stay on one line", 1, attention.getLayout().getLineCount());
        assertTrue("the second action must sit below the first", attention.getTop() >= newSession.getBottom());
        float density = context.getResources().getDisplayMetrics().density;
        int inset = Math.round(10 * density);
        // A 2x2 cell leaves this much once the header row and the gaps are paid for; the floor
        // catches a regression back to wrap_content, which made them 15dp.
        int minimum = Math.round(24 * density);
        assertTrue(
            "the actions must take the spare height: " + newSession.getHeight()
                + " and " + attention.getHeight() + " of " + view.getHeight(),
            newSession.getHeight() >= minimum && attention.getHeight() >= minimum
        );
        assertTrue(
            "both actions must stay inside the widget's padding: " + attention.getBottom() + " of " + view.getHeight(),
            attention.getBottom() <= view.getHeight() - inset
        );
        assertEquals("4 need attention", text(view, R.id.widget_attention));
    }

    @Test
    public void theSessionRowsFillTheWidgetHeight() throws Exception {
        View view = apply(WidgetRenderer.sessions(context, snapshot(2, "One", "Two", "Three", "Four", "Five")));
        layoutAt(view, 250, 180);

        // getBottom() is in the row's parent, so the container is what has to reach the padding.
        View rows = view.findViewById(R.id.widget_rows);
        int padding = Math.round(12 * context.getResources().getDisplayMetrics().density);
        int expected = view.getHeight() - padding;
        assertTrue(
            "the list must reach the bottom padding, not stop halfway: " + rows.getBottom() + " vs " + expected,
            Math.abs(rows.getBottom() - expected) <= 4
        );
    }

    /** Publishes what each widget looks like, so the artifact can be reviewed without a phone. */
    @Test
    public void theWidgetsRenderAtTheirDeclaredSizes() throws Exception {
        publish(WidgetRenderer.overview(context, snapshot(3, "Fix the login flow", "Ship the widget", "Review PR")), 250, 110, "overview");
        publish(WidgetRenderer.sessions(context, snapshot(4, "Fix the login flow", "Ship the widget", "Review PR", "minibuild", "lunar-salamander")), 250, 180, "sessions");
        publish(WidgetRenderer.quickActions(context, snapshot(4, "a")), 110, 110, "quick-actions");
    }

    private void publish(RemoteViews views, int widthDp, int heightDp, String name) throws Exception {
        View view = apply(views);
        layoutAt(view, widthDp, heightDp);
        float density = context.getResources().getDisplayMetrics().density;
        int width = Math.round(widthDp * density);
        int height = Math.round(heightDp * density);
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(
            () -> view.draw(new Canvas(bitmap))
        );

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, "openchamber-widget-" + name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures");
        Uri uri = context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        assertTrue("could not publish " + name, uri != null);
        try (java.io.OutputStream stream = context.getContentResolver().openOutputStream(uri)) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
        }
    }

    private void layoutAt(View view, int widthDp, int heightDp) {
        float density = context.getResources().getDisplayMetrics().density;
        int width = Math.round(widthDp * density);
        int height = Math.round(heightDp * density);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            view.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY)
            );
            view.layout(0, 0, width, height);
        });
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
