package com.openchamber.app;

import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Display retention only. Never acquires a CPU wake lock or wakes the device. */
@CapacitorPlugin(name = "ScreenAwake")
public class ScreenAwakePlugin extends Plugin {
    private boolean enabled;
    private boolean foreground;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean requested = call.getBoolean("enabled");
        if (requested == null) {
            call.reject("enabled must be a boolean");
            return;
        }
        getActivity().runOnUiThread(() -> {
            enabled = requested;
            apply();
            call.resolve();
        });
    }

    private void apply() {
        if (enabled && foreground) {
            getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    @Override
    protected void handleOnResume() {
        foreground = true;
        apply();
    }

    @Override
    protected void handleOnPause() {
        foreground = false;
        apply();
    }

    @Override
    protected void handleOnDestroy() {
        enabled = false;
        foreground = false;
        apply();
    }
}
