package com.openchamber.app;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "SharedIntent";

    // Reading a share means file I/O and base64; one reader keeps shares in arrival order.
    private final ExecutorService shareReader = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "openchamber-share-intake");
        thread.setDaemon(true);
        return thread;
    });

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
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(SharedFilesPlugin.class);
        super.onCreate(savedInstanceState);
        // With singleTask, each share is its own event: this intent on a cold start, later
        // ones through onNewIntent. Rotation does not recreate the activity (configChanges).
        // A recreated activity repeats the original intent, which would arm a share the page
        // already took, so only a real cold start reads it.
        if (savedInstanceState == null) {
            readShare(getIntent());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readShare(intent);
    }

    private void readShare(Intent intent) {
        if (intent == null) {
            return;
        }
        shareReader.execute(() -> {
            try {
                SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, getContentResolver());
                if (payload == null) {
                    return;
                }
                SharedPayloadStore.put(payload);
                Log.i(TAG, "Stored share: text=" + (payload.text != null)
                    + " files=" + payload.files.size() + " rejected=" + payload.rejected.size());
            } catch (RuntimeException error) {
                Log.w(TAG, "Could not read the shared intent", error);
            }
        });
    }

    @Override
    protected void load() {
        // Capacitor inflates a plain CapacitorWebView, which tells the IME it accepts no
        // content. Swap in ours before the bridge resolves the WebView by id.
        setContentView(R.layout.activity_main);
        super.load();
    }
}
