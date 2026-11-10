package com.openchamber.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;
import java.util.List;

/**
 * Builds one widget's RemoteViews from the stored snapshot. Kept in one place so the four widget
 * types share the row markup and the unread/attention rules instead of drifting apart.
 */
final class WidgetRenderer {

    /** How many session rows each layout declares; the rest stay hidden. */
    private static final int OVERVIEW_ROWS = 3;
    private static final int SESSIONS_ROWS = 5;

    private WidgetRenderer() {}

    static RemoteViews overview(Context context, WidgetSnapshot snapshot) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_overview);
        header(views, snapshot);
        rows(context, views, snapshot, OVERVIEW_ROWS, false);
        views.setOnClickPendingIntent(R.id.widget_new, WidgetIntents.newSession(context));
        return views;
    }

    static RemoteViews sessions(Context context, WidgetSnapshot snapshot) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_sessions);
        header(views, snapshot);
        rows(context, views, snapshot, SESSIONS_ROWS, true);
        views.setOnClickPendingIntent(R.id.widget_new, WidgetIntents.newSession(context));
        return views;
    }

    static RemoteViews quickActions(Context context, WidgetSnapshot snapshot) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_quick_actions);
        views.setTextViewText(R.id.widget_attention, snapshot.attentionCount > 0 ? snapshot.attentionLabel() : "");
        // Set through actions like every other label: a static android:text is what the widget
        // host renders, but it is also what an offline render of the layout cannot show.
        views.setTextViewText(R.id.quick_new, context.getString(R.string.widget_new_session));
        views.setTextViewText(R.id.quick_attention, context.getString(R.string.widget_attention));
        views.setOnClickPendingIntent(R.id.quick_new, WidgetIntents.newSession(context));
        views.setOnClickPendingIntent(R.id.quick_attention, WidgetIntents.attention(context));
        return views;
    }

    static RemoteViews newSession(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_new_session);
        views.setOnClickPendingIntent(R.id.new_session_root, WidgetIntents.newSession(context));
        return views;
    }

    private static void header(RemoteViews views, WidgetSnapshot snapshot) {
        // The iOS widget shows the bare count in its header; the phrase would not fit the tile.
        views.setTextViewText(R.id.widget_attention, snapshot.attentionCount > 0 ? String.valueOf(snapshot.attentionCount) : "");
    }

    private static void rows(Context context, RemoteViews views, WidgetSnapshot snapshot, int slotCount, boolean withProject) {
        List<WidgetSession> sessions = snapshot.recentSessions;
        for (int slot = 0; slot < slotCount; slot++) {
            int rowId = rowId(slot);
            boolean visible = slot < sessions.size();
            views.setViewVisibility(rowId, visible ? View.VISIBLE : View.GONE);
            if (!visible) {
                continue;
            }
            WidgetSession session = sessions.get(slot);
            views.setTextViewText(titleId(slot), session.title.isEmpty() ? context.getString(R.string.widget_untitled) : session.title);
            views.setImageViewResource(
                dotId(slot),
                session.unread ? R.drawable.widget_dot_unread : R.drawable.widget_dot_read
            );
            views.setOnClickPendingIntent(rowId, WidgetIntents.session(context, session.id, slot));
            if (withProject && session.project != null && !session.project.isEmpty()) {
                views.setTextViewText(projectId(slot), session.project);
                views.setViewVisibility(projectId(slot), View.VISIBLE);
            } else if (withProject) {
                views.setViewVisibility(projectId(slot), View.GONE);
            }
        }
        boolean empty = sessions.isEmpty();
        // The empty label and the list share the same weight, so only one of them may be laid out.
        views.setViewVisibility(R.id.widget_rows, empty ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.widget_empty, empty ? View.VISIBLE : View.GONE);
        if (empty) {
            views.setTextViewText(R.id.widget_empty, context.getString(R.string.widget_no_sessions));
        }
    }

    private static int[] rowIds(int slot) {
        return new int[] { R.id.r1, R.id.r2, R.id.r3, R.id.r4, R.id.r5 };
    }

    private static int rowId(int slot) {
        return rowIds(slot)[slot];
    }

    private static int titleId(int slot) {
        return new int[] { R.id.r1_title, R.id.r2_title, R.id.r3_title, R.id.r4_title, R.id.r5_title }[slot];
    }

    private static int dotId(int slot) {
        return new int[] { R.id.r1_dot, R.id.r2_dot, R.id.r3_dot, R.id.r4_dot, R.id.r5_dot }[slot];
    }

    private static int projectId(int slot) {
        return new int[] { R.id.r1_project, R.id.r2_project, R.id.r3_project, R.id.r4_project, R.id.r5_project }[slot];
    }
}
