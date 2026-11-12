package com.openchamber.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Reads the clipboard as text for the terminal's Paste button.
 *
 * Android WebView rejects navigator.clipboard.readText() with "Read permission
 * denied" and offers no prompt the page could trigger, so the web layer asks
 * here instead. An empty clipboard, or one holding no text, answers "".
 */
@CapacitorPlugin(name = "ClipboardText")
public class ClipboardTextPlugin extends Plugin {

    @PluginMethod
    public void read(PluginCall call) {
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
        CharSequence text = null;
        if (clip != null && clip.getItemCount() > 0) {
            text = clip.getItemAt(0).coerceToText(getContext());
        }
        JSObject result = new JSObject();
        result.put("text", text == null ? "" : text.toString());
        call.resolve(result);
    }
}
