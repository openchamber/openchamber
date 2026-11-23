package com.openchamber.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import java.lang.ref.WeakReference;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The connected WebView writes redacted widget snapshots; widgets never receive API tokens. */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {
    private static volatile WeakReference<WidgetBridgePlugin> instance = new WeakReference<>(null);

    @Override
    public void load() {
        instance = new WeakReference<>(this);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance.get() == this) instance = new WeakReference<>(null);
        super.handleOnDestroy();
    }

    /**
     * Dispatch promptly to a running WebView without opening the activity.
     * The persisted request counter remains the fallback when the WebView
     * was killed or the event could not be delivered while backgrounded.
     */
    static boolean notifyRefreshRequested(int request) {
        WidgetBridgePlugin plugin = instance.get();
        // No listener means the app is not connected yet; the request waits in the queue.
        if (plugin == null || !plugin.hasListeners("refreshRequested")) return false;
        new Handler(Looper.getMainLooper()).post(() -> {
            JSObject state = new JSObject();
            state.put("requested", request);
            plugin.notifyListeners("refreshRequested", state, true);
        });
        return true;
    }

    /** A widget was placed or the last one removed: the app re-reads which widgets exist. */
    static void notifyWidgetsChanged() {
        WidgetBridgePlugin plugin = instance.get();
        if (plugin == null) return;
        new Handler(Looper.getMainLooper()).post(() ->
            plugin.notifyListeners("widgetsChanged", new JSObject()));
    }

    /** Which widgets are on the home screen; the app syncs nothing while there are none. */
    @PluginMethod
    public void installed(PluginCall call) {
        JSObject result = new JSObject();
        result.put("usage", WidgetRenderer.hasWidgets(getContext(), UsageWidgetProvider.class));
        result.put("sessions", WidgetRenderer.hasWidgets(getContext(), SessionsWidgetProvider.class));
        call.resolve(result);
    }

    /**
     * Native refresh intent queue; web credentials and network access remain
     * exclusively in the connected WebView. Polling this lightweight local
     * counter catches taps even when Android does not emit appUrlOpen.
     */
    @PluginMethod
    public void pendingRefresh(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(WidgetRenderer.PREFS, Context.MODE_PRIVATE);
        JSObject result = new JSObject();
        result.put("requested", prefs.getInt("refresh_requested", 0));
        result.put("acknowledged", prefs.getInt("refresh_acknowledged", 0));
        call.resolve(result);
    }

    @PluginMethod
    public void acknowledgeRefresh(PluginCall call) {
        Integer sequence = call.getInt("requested");
        if (sequence == null) {
            call.reject("Missing refresh sequence");
            return;
        }
        SharedPreferences prefs = getContext().getSharedPreferences(WidgetRenderer.PREFS, Context.MODE_PRIVATE);
        int requested = prefs.getInt("refresh_requested", 0);
        int acknowledged = prefs.getInt("refresh_acknowledged", 0);
        if (sequence > acknowledged && sequence <= requested) {
            prefs.edit().putInt("refresh_acknowledged", sequence).apply();
            WidgetRenderer.refresh(getContext());
        }
        call.resolve(new JSObject());
    }

    /** Distinguish a failed network refresh from a successful server sync. */
    @PluginMethod
    public void reportRefreshFailure(PluginCall call) {
        Integer sequence = call.getInt("requested");
        if (sequence == null) {
            call.reject("Missing refresh sequence");
            return;
        }
        SharedPreferences prefs = getContext().getSharedPreferences(WidgetRenderer.PREFS, Context.MODE_PRIVATE);
        int requested = prefs.getInt("refresh_requested", 0);
        // A failure covers taps made while it ran; a later tap clears it by counting past it.
        if (sequence <= requested) {
            prefs.edit().putInt("refresh_failed", requested).apply();
            WidgetRenderer.refresh(getContext());
        }
        call.resolve(new JSObject());
    }

    /** Either snapshot may be absent: the app sends only what it knows; the other stays. */
    @PluginMethod
    public void update(PluginCall call) {
        try {
            String usage = call.getString("usage");
            String sessions = call.getString("sessions");
            if ((usage == null && sessions == null)
                || (usage != null && usage.length() > 65536)
                || (sessions != null && sessions.length() > 65536)) {
                call.reject("Invalid widget snapshots");
                return;
            }
            SharedPreferences.Editor editor =
                getContext().getSharedPreferences(WidgetRenderer.PREFS, Context.MODE_PRIVATE).edit();
            if (usage != null) editor.putString("usage", usage);
            if (sessions != null) editor.putString("sessions", sessions);
            editor.apply();
            WidgetRenderer.refresh(getContext());
            call.resolve(new JSObject());
        } catch (Exception error) {
            call.reject("Widget update failed", error);
        }
    }
}
