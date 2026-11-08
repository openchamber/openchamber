package com.openchamber.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The home-screen widgets' only data source, mirroring the JSON the iOS widgets read from the
 * App Group (packages/ui/src/apps/mobileWidgetSnapshot.ts builds it for both platforms).
 *
 * The web layer is the authority: the app hands over its string and reads it back unchanged, so
 * a field added there needs no code here unless a widget renders it.
 */
public final class WidgetSnapshot {

    public final String runtimeKey;
    public final int attentionCount;
    public final List<WidgetSession> recentSessions;

    private WidgetSnapshot(String runtimeKey, int attentionCount, List<WidgetSession> recentSessions) {
        this.runtimeKey = runtimeKey;
        this.attentionCount = attentionCount;
        this.recentSessions = recentSessions;
    }

    public static WidgetSnapshot empty() {
        return new WidgetSnapshot(null, 0, Collections.emptyList());
    }

    /** Returns an empty snapshot rather than throwing: a widget must still render something. */
    public static WidgetSnapshot parse(String json) {
        if (json == null || json.isEmpty()) {
            return empty();
        }
        try {
            JSONObject root = new JSONObject(json);
            List<WidgetSession> sessions = new ArrayList<>();
            JSONArray array = root.optJSONArray("recentSessions");
            if (array != null) {
                for (int index = 0; index < array.length(); index++) {
                    JSONObject item = array.optJSONObject(index);
                    if (item == null) {
                        continue;
                    }
                    String id = item.optString("id", "");
                    if (id.isEmpty()) {
                        continue;
                    }
                    sessions.add(
                        new WidgetSession(
                            id,
                            item.optString("title", ""),
                            item.optBoolean("unread", false),
                            item.optString("project", "")
                        )
                    );
                }
            }
            return new WidgetSnapshot(root.optString("runtimeKey", null), root.optInt("attentionCount", 0), sessions);
        } catch (Exception error) {
            return empty();
        }
    }

    public String attentionLabel() {
        return attentionCount == 1 ? "1 needs attention" : attentionCount + " need attention";
    }
}
