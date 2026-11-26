package com.openchamber.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "SharedIntent";
    private static final String STATE_SETTLED_SHARES = "settledShareSignatures";
    private static final String STATE_SHARE_CONTENT = "currentShareContent";
    private static final String STATE_SHARE_DELIVERY = "currentShareDelivery";

    /** The share this activity last received, so a restored activity reads it under the same delivery. */
    private String currentShareContent;
    private String currentShareDelivery;

    /**
     * Reading a share means file I/O and base64. One reader for the whole process keeps shares in
     * arrival order and stops a recreated activity from starting a second one; at most one more
     * share waits behind it, and a newer one replaces the waiting one, since the newest share is
     * the one the page receives anyway.
     */
    private static final ThreadPoolExecutor SHARE_READER = new ThreadPoolExecutor(
        1,
        1,
        0L,
        TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(1),
        runnable -> {
            Thread thread = new Thread(runnable, "openchamber-share-intake");
            thread.setDaemon(true);
            return thread;
        },
        (rejected, executor) -> {
            Runnable waiting = executor.getQueue().poll();
            if (waiting instanceof ShareRead) {
                SharedPayloadStore.supersede(((ShareRead) waiting).signature);
            }
            if (!executor.getQueue().offer(rejected) && rejected instanceof ShareRead) {
                SharedPayloadStore.release(((ShareRead) rejected).signature);
            }
        }
    );

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge starts.
        registerPlugin(ClipboardTextPlugin.class);
        registerPlugin(FileSharePlugin.class);
        registerPlugin(ImagePastePlugin.class);
        registerPlugin(PushKeyPlugin.class);
        registerPlugin(PushBannersPlugin.class);
        registerPlugin(ReadingAudioFocusPlugin.class);
        registerPlugin(WindowLayoutPlugin.class);
        registerPlugin(RuntimeWebSocketPlugin.class);
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(MobileDevTunnelPlugin.class);
        registerPlugin(SharedFilesPlugin.class);
        registerPlugin(ShortcutRequestsPlugin.class);
        if (savedInstanceState != null) {
            SharedPayloadStore.restoreSettled(savedInstanceState.getStringArrayList(STATE_SETTLED_SHARES));
        }
        super.onCreate(savedInstanceState);
        // With singleTask, each share is its own event: this intent on a cold start, later ones
        // through onNewIntent. A recreated activity comes back with an intent it already had; it
        // reads it again under the same delivery, so the store reads it only when the page has not
        // accepted it and no read of it is running.
        Intent intent = getIntent();
        takeDictateShortcut(intent, savedInstanceState != null);
        String content = SharedIntentReader.contentSignature(intent);
        String delivery = SharedIntentReader.launchDelivery(
            content,
            content == null ? null : intent.getStringExtra(SharedIntentReader.EXTRA_DELIVERY),
            savedInstanceState != null,
            savedInstanceState == null ? null : savedInstanceState.getString(STATE_SHARE_CONTENT),
            savedInstanceState == null ? null : savedInstanceState.getString(STATE_SHARE_DELIVERY),
            intent != null && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0,
            UUID.randomUUID().toString()
        );
        if (delivery != null) {
            readShare(intent, content, delivery);
        }
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        ArrayList<String> settled = SharedPayloadStore.settledSignatures();
        if (!settled.isEmpty()) {
            outState.putStringArrayList(STATE_SETTLED_SHARES, settled);
        }
        if (currentShareDelivery != null) {
            outState.putString(STATE_SHARE_CONTENT, currentShareContent);
            outState.putString(STATE_SHARE_DELIVERY, currentShareDelivery);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // Capacitor's load() replays the launch intent here during onCreate, which already took it.
        boolean launchIntent = intent == getIntent();
        super.onNewIntent(intent);
        setIntent(intent);
        if (!launchIntent) {
            takeDictateShortcut(intent, false);
        }
        String content = SharedIntentReader.contentSignature(intent);
        if (content != null) {
            // A new intent is a new share even when it carries the same link or file as an earlier one.
            readShare(intent, content, UUID.randomUUID().toString());
        }
    }

    private static void takeDictateShortcut(Intent intent, boolean restored) {
        if (intent == null || intent.getComponent() == null) {
            return;
        }
        boolean fromHistory = (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        if (DictateShortcut.isRequest(intent.getComponent().getClassName(), fromHistory, restored)) {
            DictateShortcut.deliver();
        }
    }

    private void readShare(Intent intent, String content, String delivery) {
        intent.putExtra(SharedIntentReader.EXTRA_DELIVERY, delivery);
        currentShareContent = content;
        currentShareDelivery = delivery;
        String signature = SharedIntentReader.signature(intent);
        if (!SharedPayloadStore.claim(signature)) {
            return;
        }
        Context context = getApplicationContext();
        SHARE_READER.execute(new ShareRead(intent, signature, context.getContentResolver(), getPackageName(), readGrant(context)));
    }

    /** Only a URI the sender granted this app read access to; an exported provider alone is not enough. */
    private static SharedIntentReader.ReadGrant readGrant(Context context) {
        int pid = Process.myPid();
        int uid = Process.myUid();
        return uri -> context.checkUriPermission(uri, pid, uid, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private static final class ShareRead implements Runnable {
        final Intent intent;
        final String signature;
        final ContentResolver resolver;
        final String ownPackage;
        final SharedIntentReader.ReadGrant grant;

        ShareRead(Intent intent, String signature, ContentResolver resolver, String ownPackage, SharedIntentReader.ReadGrant grant) {
            this.intent = intent;
            this.signature = signature;
            this.resolver = resolver;
            this.ownPackage = ownPackage;
            this.grant = grant;
        }

        @Override
        public void run() {
            long started = System.nanoTime();
            try {
                SharedPayloadStore.SharedPayload payload = SharedIntentReader.read(intent, resolver, ownPackage, grant);
                if (payload == null) {
                    SharedPayloadStore.release(signature);
                    return;
                }
                SharedPayloadStore.put(payload);
                Log.i(TAG, "Stored share: text=" + (payload.text != null)
                    + " files=" + payload.files.size()
                    + " rejected=" + payload.rejected.size()
                    + " in " + ((System.nanoTime() - started) / 1_000_000L) + "ms");
            } catch (RuntimeException error) {
                SharedPayloadStore.release(signature);
                Log.w(TAG, "Could not read the shared intent: " + error.getClass().getSimpleName());
            }
        }
    }

    @Override
    protected void load() {
        // Capacitor inflates a plain CapacitorWebView, which tells the IME it accepts no
        // content. Swap in ours before the bridge resolves the WebView by id.
        setContentView(R.layout.activity_main);
        super.load();
    }
}
