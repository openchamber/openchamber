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
    }

    @Override
    public void onResume() {
        super.onResume();
        // Same trigger as the iOS scene activation: store what the page shows and repaint widgets.
        WidgetBridge.capture(this);
    }

    @Override
    public void onPause() {
        WidgetBridge.capture(this);
        super.onPause();
    }

    @Override
    protected void load() {
        // Capacitor inflates a plain CapacitorWebView, which tells the IME it accepts no
        // content. Swap in ours before the bridge resolves the WebView by id.
        setContentView(R.layout.activity_main);
        super.load();
    }
}
