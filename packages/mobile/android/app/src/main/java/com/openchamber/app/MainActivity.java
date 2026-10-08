package com.openchamber.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge starts.
        registerPlugin(FileSharePlugin.class);
        registerPlugin(ImagePastePlugin.class);
        registerPlugin(PushKeyPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void load() {
        // Capacitor inflates a plain CapacitorWebView, which tells the IME it accepts no
        // content. Swap in ours before the bridge resolves the WebView by id.
        setContentView(R.layout.activity_main);
        super.load();
    }
}
