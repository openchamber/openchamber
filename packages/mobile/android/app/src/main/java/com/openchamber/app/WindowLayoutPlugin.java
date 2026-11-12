package com.openchamber.app;

import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the web layer whether Android forces this window edge to edge.
 *
 * The app targets SDK 35, so Android 15 and newer always draw it under the system bars,
 * while older versions honour StatusBar.setOverlaysWebView({ overlay: false }). The page
 * cannot read the OS version itself: hardened WebViews such as GrapheneOS's Vanadium send
 * the reduced "Android 10; K" user agent on every release.
 */
@CapacitorPlugin(name = "WindowLayout")
public class WindowLayoutPlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        result.put("edgeToEdge", Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM);
        call.resolve(result);
    }
}
