package com.openchamber.app;

import android.app.NotificationManager;
import android.content.Context;
import android.service.notification.StatusBarNotification;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Removes the session banners the web layer saw once the user opened their
 * session (nativeNotifications.ts). The push plugin's own removal cancels by
 * tag and id, which would also take a newer push that replaced the banner in
 * the meantime; this one cancels a banner only while it still shows the push
 * the web layer listed (see SeenBanners).
 */
@CapacitorPlugin(name = "PushBanners")
public class PushBannersPlugin extends Plugin {

    @PluginMethod
    public void remove(PluginCall call) {
        JSArray banners = call.getArray("banners");
        if (banners == null) {
            call.reject("Expected banners");
            return;
        }
        SeenBanners seen = new SeenBanners();
        try {
            for (Object item : banners.toList()) {
                if (!(item instanceof JSONObject)) continue;
                JSONObject banner = (JSONObject) item;
                if (!banner.has("id")) continue;
                seen.add(
                    banner.isNull("tag") ? null : banner.getString("tag"),
                    banner.getInt("id"),
                    banner.isNull("nid") ? null : banner.getString("nid")
                );
            }
        } catch (JSONException error) {
            call.reject(error.getMessage());
            return;
        }

        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null && !seen.isEmpty()) {
            synchronized (SeenBanners.LOCK) {
                for (StatusBarNotification shown : manager.getActiveNotifications()) {
                    String nid = shown.getNotification().extras.getString(SealedPushMessagingService.NOTIFICATION_ID_EXTRA);
                    if (!seen.stillShows(shown.getTag(), shown.getId(), nid)) continue;
                    if (shown.getTag() == null) manager.cancel(shown.getId());
                    else manager.cancel(shown.getTag(), shown.getId());
                }
            }
        }
        call.resolve();
    }
}
