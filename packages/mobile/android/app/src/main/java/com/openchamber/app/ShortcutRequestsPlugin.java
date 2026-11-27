package com.openchamber.app;

import android.app.Activity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hands the Dictate quick action to the page (packages/ui/src/lib/nativeShortcutRequests.ts), the
 * same plugin name and shape the iOS app uses. Announces a request with a bare {@code pending}
 * event; the page then takes it, so it is handed out exactly once.
 */
@CapacitorPlugin(name = "ShortcutRequests")
public class ShortcutRequestsPlugin extends Plugin implements DictateShortcut.Listener {

    @Override
    public void load() {
        DictateShortcut.setListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        DictateShortcut.clearListener(this);
    }

    @PluginMethod
    public void takePending(PluginCall call) {
        JSObject result = new JSObject();
        if (DictateShortcut.take()) {
            JSObject request = new JSObject();
            request.put("dictate", true);
            result.put("request", request);
        }
        call.resolve(result);
    }

    @Override
    public void onPending() {
        Activity activity = getActivity();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            if (getBridge() != null) {
                notifyListeners("pending", new JSObject());
            }
        });
    }
}
