package com.openchamber.app;

import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import org.json.JSONArray;

/**
 * Pulls the snapshot out of the page and stores it, the same way the iOS app evaluates
 * window.__OPENCHAMBER_WIDGET_SNAPSHOT__ when its scene activates; neither platform needs a
 * plugin because the page already exposes the function (packages/ui/src/apps/mobileWidgetSnapshot.ts).
 */
final class WidgetBridge {

    private static final String SCRIPT =
        "(function(){try{"
            + "return typeof window.__OPENCHAMBER_WIDGET_SNAPSHOT__ === 'function'"
            + " ? window.__OPENCHAMBER_WIDGET_SNAPSHOT__() : null;"
            + "}catch(e){return null;}})()";

    private WidgetBridge() {}

    static void capture(BridgeActivity activity) {
        WebView webView = activity.getBridge() == null ? null : activity.getBridge().getWebView();
        if (webView == null) {
            return;
        }
        webView.post(() -> {
            try {
                webView.evaluateJavascript(SCRIPT, value -> {
                    String json = unwrap(value);
                    if (json == null) {
                        return;
                    }
                    if (WidgetSnapshotStore.write(activity.getApplicationContext(), json)) {
                        BaseWidgetProvider.refreshAll(activity.getApplicationContext());
                    }
                });
            } catch (Exception error) {
                // The page may be reloading; the next resume captures again.
            }
        });
    }

    /** evaluateJavascript answers a JSON literal, so a string result arrives quoted and escaped. */
    private static String unwrap(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty() || "null".equals(trimmed)) {
            return null;
        }
        try {
            return new JSONArray("[" + trimmed + "]").getString(0);
        } catch (Exception error) {
            return null;
        }
    }
}
