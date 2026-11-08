package com.openchamber.app;

import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import java.net.URLEncoder;

/**
 * Every widget tap becomes the same openchamber:// link the launcher shortcuts and the tile use,
 * so the widgets never carry a destination of their own and routing stays in the web layer.
 */
final class WidgetIntents {

    private static final int NEW_SESSION = 1;
    private static final int ATTENTION = 2;
    private static final int SESSION = 3;

    private WidgetIntents() {}

    static PendingIntent newSession(Context context) {
        return pending(context, "openchamber://new-session", NEW_SESSION);
    }

    static PendingIntent attention(Context context) {
        return pending(context, "openchamber://sessions?filter=attention", ATTENTION);
    }

    static PendingIntent session(Context context, String id, int slot) {
        String encoded;
        try {
            encoded = URLEncoder.encode(id, "UTF-8");
        } catch (Exception error) {
            encoded = id;
        }
        // The slot keeps row intents distinct; PendingIntents differing only in data still
        // collide when the request code matches.
        return pending(context, "openchamber://session/" + encoded, SESSION * 100 + slot);
    }

    private static PendingIntent pending(Context context, String url, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setComponent(new ComponentName(context, MainActivity.class));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
