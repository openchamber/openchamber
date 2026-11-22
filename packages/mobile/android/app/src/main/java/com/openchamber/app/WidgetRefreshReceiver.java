package com.openchamber.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/**
 * Manual refresh is a native widget broadcast, never a launch-activity link.
 * The connected WebView owns authenticated server calls. When it isn't running,
 * the pending request remains queued and the widget indicates that honestly.
 */
public class WidgetRefreshReceiver extends BroadcastReceiver {
    static final String ACTION = "com.openchamber.app.action.REFRESH_WIDGETS";
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        SharedPreferences prefs = context.getSharedPreferences(WidgetRenderer.PREFS, Context.MODE_PRIVATE);
        int next = prefs.getInt("refresh_requested", 0) + 1;
        // Commit before signaling so a connected WebView sees the request.
        prefs.edit().putInt("refresh_requested", next).putLong("refresh_requested_at",
            System.currentTimeMillis()).putBoolean("refresh_client_available", false).commit();
        boolean available = WidgetBridgePlugin.notifyRefreshRequested(next);
        prefs.edit().putBoolean("refresh_client_available", available).apply();
        WidgetRenderer.refresh(context);
    }
}
