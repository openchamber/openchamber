package com.openchamber.app;

import android.app.ActivityManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;
import org.json.JSONObject;

/**
 * Replaces the push plugin's messaging service (see AndroidManifest.xml) to
 * show sealed pushes. A sealed push arrives as a data message: the relay
 * leaves out the visible notification so this service runs even with the app
 * in the background, opens `enc` with this phone's key and shows the real
 * title and body. If it cannot be opened, the generic title the relay sent in
 * `title` is shown instead. Everything else, and every message while the app
 * is in front (where pushes are not shown, as before), goes to the plugin.
 */
public class SealedPushMessagingService extends MessagingService {

    private static final String CHANNEL_ID = "openchamber_sealed_push";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        String sealed = data.get("enc");
        if (sealed == null || remoteMessage.getNotification() != null || isInForeground()) {
            super.onMessageReceived(remoteMessage);
            return;
        }

        String title = data.containsKey("title") ? data.get("title") : "OpenChamber";
        String body = "";
        String opened = PushSealKey.open(this, sealed);
        if (opened != null) {
            try {
                JSONObject content = new JSONObject(opened);
                title = content.optString("title", title);
                body = content.optString("body", "");
            } catch (Exception error) {
                // Keep the generic title.
            }
        }
        show(remoteMessage, data, title, body);
    }

    private void show(RemoteMessage remoteMessage, Map<String, String> data, String title, String body) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                new NotificationChannel(CHANNEL_ID, getString(R.string.sealed_push_channel_name), NotificationManager.IMPORTANCE_HIGH)
            );
        }

        // The extras match what the system puts on a notification it shows itself,
        // so the push plugin reports the tap and the app opens the session.
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        String messageId = remoteMessage.getMessageId() != null ? remoteMessage.getMessageId() : String.valueOf(System.currentTimeMillis());
        intent.putExtra("google.message_id", messageId);
        for (Map.Entry<String, String> entry : data.entrySet()) {
            if (!"enc".equals(entry.getKey())) intent.putExtra(entry.getKey(), entry.getValue());
        }
        int requestCode = messageId.hashCode();
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent);
        String badge = data.get("badge");
        if (badge != null) {
            try {
                builder.setNumber(Integer.parseInt(badge));
            } catch (NumberFormatException error) {
                // No count.
            }
        }

        String tag = remoteMessage.getCollapseKey();
        try {
            NotificationManagerCompat.from(this).notify(tag, requestCode, builder.build());
        } catch (SecurityException error) {
            // Notification permission withdrawn; nothing to show.
        }
    }

    private static boolean isInForeground() {
        ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(info);
        return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }
}
