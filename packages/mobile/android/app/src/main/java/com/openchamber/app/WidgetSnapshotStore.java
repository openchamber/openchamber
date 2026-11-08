package com.openchamber.app;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps the widget snapshot in SharedPreferences. The app writes it while it runs, so a widget
 * launched with the app closed still shows the last known state, and the push service can update
 * the attention count the way the iOS notification service extension does.
 */
public final class WidgetSnapshotStore {

    private static final String PREFS = "openchamber_widget";
    private static final String KEY = "widgetSnapshot";

    private WidgetSnapshotStore() {}

    public static WidgetSnapshot read(Context context) {
        return WidgetSnapshot.parse(raw(context));
    }

    public static String raw(Context context) {
        return prefs(context).getString(KEY, null);
    }

    /** Writes only when the string differs, so an idle resume does not repaint every widget. */
    public static boolean write(Context context, String json) {
        if (json == null || json.isEmpty() || "null".equals(json)) {
            // The page returns null when it cannot build a snapshot; keep the last good one.
            return false;
        }
        if (json.equals(raw(context))) {
            return false;
        }
        prefs(context).edit().putString(KEY, json).apply();
        return true;
    }

    /**
     * Applies what a push tells us while the app is not running: the badge count and the session
     * that just changed. A push from another runtime replaces the snapshot, because the sessions
     * it holds belong to a server this phone is no longer talking to.
     */
    public static boolean applyPush(Context context, String runtimeKey, Integer badge, String sessionId) {
        WidgetSnapshot current = read(context);
        if (runtimeKey != null && !runtimeKey.isEmpty() && !runtimeKey.equals(current.runtimeKey)) {
            // Another server: its sessions are gone, but its count still applies.
            return writeJson(context, runtimeKey, badge == null ? 0 : badge, new JSONArray());
        }
        if (badge == null && sessionId == null) {
            return false;
        }
        JSONArray sessions = new JSONArray();
        for (WidgetSession session : current.recentSessions) {
            JSONObject item = new JSONObject();
            try {
                item.put("id", session.id);
                item.put("title", session.title);
                item.put("unread", session.unread || session.id.equals(sessionId));
                item.put("project", session.project);
            } catch (Exception error) {
                continue;
            }
            sessions.put(item);
        }
        return writeJson(
            context,
            current.runtimeKey,
            badge == null ? current.attentionCount : badge,
            sessions
        );
    }

    private static boolean writeJson(Context context, String runtimeKey, int attentionCount, JSONArray sessions) {
        try {
            JSONObject root = new JSONObject();
            root.put("runtimeKey", runtimeKey == null ? "" : runtimeKey);
            root.put("attentionCount", attentionCount);
            root.put("recentSessions", sessions);
            return write(context, root.toString());
        } catch (Exception error) {
            return false;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
