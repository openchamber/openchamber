package com.openchamber.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Hands the web layer this phone's push seal key (see PushSealKey). */
@CapacitorPlugin(name = "PushKey")
public class PushKeyPlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        result.put("key", PushSealKey.get(getContext()));
        call.resolve(result);
    }
}
