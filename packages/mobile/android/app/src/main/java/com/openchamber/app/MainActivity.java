package com.openchamber.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge starts.
        registerPlugin(ClipboardTextPlugin.class);
        registerPlugin(FileSharePlugin.class);
        registerPlugin(ImagePastePlugin.class);
        registerPlugin(PushKeyPlugin.class);
        registerPlugin(ReadingAudioFocusPlugin.class);
        registerPlugin(WindowLayoutPlugin.class);
        registerPlugin(RuntimeWebSocketPlugin.class);
        super.onCreate(savedInstanceState);
        // The WebView scales all text by the system font size by default, which
        // inflated every screen on phones with a larger system font. Text size is
        // set inside the app (Settings > Appearance > Interface Font Size).
        getBridge().getWebView().getSettings().setTextZoom(100);
    }

    @Override
    protected void load() {
        // Capacitor inflates a plain CapacitorWebView, which tells the IME it accepts no
        // content. Swap in ours before the bridge resolves the WebView by id.
        setContentView(R.layout.activity_main);
        super.load();
    }
}
