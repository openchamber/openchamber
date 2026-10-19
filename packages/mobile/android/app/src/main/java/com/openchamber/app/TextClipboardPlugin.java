package com.openchamber.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Plain-text clipboard reads for the terminal's explicit Paste action. */
@CapacitorPlugin(name = "TextClipboard")
public class TextClipboardPlugin extends Plugin {
    @PluginMethod
    public void readText(PluginCall call) {
        ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
        if (clipboard == null) {
            call.reject("Clipboard service unavailable");
            return;
        }
        try {
            ClipData clip = clipboard.getPrimaryClip();
            CharSequence text = clip != null && clip.getItemCount() > 0
                ? clip.getItemAt(0).getText() : null;
            JSObject result = new JSObject();
            result.put("text", text == null ? "" : text.toString());
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject("Clipboard access denied", error);
        }
    }
}
