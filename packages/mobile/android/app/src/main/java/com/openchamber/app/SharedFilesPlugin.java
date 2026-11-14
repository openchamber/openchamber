package com.openchamber.app;

import android.app.Activity;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** Hands content shared from other apps to the page, mirroring the iOS SharedFiles plugin. */
@CapacitorPlugin(name = "SharedFiles")
public class SharedFilesPlugin extends Plugin implements SharedPayloadStore.Listener {

    @Override
    public void load() {
        SharedPayloadStore.setListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        SharedPayloadStore.clearListener(this);
    }

    @PluginMethod
    public void takePending(PluginCall call) {
        SharedPayloadStore.SharedPayload payload = SharedPayloadStore.take();
        call.resolve(toResult(payload == null ? SharedPayloadStore.SharedPayload.EMPTY : payload));
    }

    @Override
    public void onPendingStored() {
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

    private static JSObject toResult(SharedPayloadStore.SharedPayload payload) {
        JSObject result = new JSObject();
        result.put("text", payload.text == null ? JSONObject.NULL : payload.text);

        JSArray files = new JSArray();
        for (SharedPayloadStore.FilePayload file : payload.files) {
            JSObject item = new JSObject();
            item.put("name", file.name);
            item.put("mimeType", file.mimeType);
            item.put("data", file.data);
            files.put(item);
        }
        result.put("files", files);

        JSArray rejected = new JSArray();
        for (SharedPayloadStore.Rejection entry : payload.rejected) {
            JSObject item = new JSObject();
            item.put("name", entry.name);
            item.put("reason", entry.reason);
            rejected.put(item);
        }
        result.put("rejected", rejected);
        return result;
    }
}
