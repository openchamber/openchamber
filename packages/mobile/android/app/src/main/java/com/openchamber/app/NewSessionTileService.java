package com.openchamber.app;

import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * The Quick Settings tile that starts a new session, the Android counterpart of the iOS
 * Control Center control (OpenChamberControl.swift).
 *
 * A tile is a toggle in the panel's model, but there is nothing to toggle here, so it always
 * reports inactive and the tap is what matters: it opens the same openchamber://new-session
 * deep link the iOS control opens, which keeps routing in the web layer.
 */
public class NewSessionTileService extends TileService {

    private static final String NEW_SESSION_URL = "openchamber://new-session";

    @Override
    public void onStartListening() {
        super.onStartListening();
        Tile tile = getQsTile();
        if (tile == null) {
            return;
        }
        tile.setState(Tile.STATE_INACTIVE);
        tile.setLabel(getText(R.string.tile_new_session));
        tile.setContentDescription(getText(R.string.tile_new_session_description));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.setSubtitle(getText(R.string.tile_new_session_subtitle));
        }
        tile.setIcon(Icon.createWithResource(this, R.drawable.ic_tile_new_session));
        tile.updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(NEW_SESSION_URL));
        // Explicit component: the tile can be tapped while the app is not running, and an
        // explicit intent reaches the activity even when the scheme is not the entry point.
        intent.setComponent(new ComponentName(this, MainActivity.class));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14 replaced the intent overload with a PendingIntent one; the old call
            // starts the activity behind the shade on some builds.
            PendingIntent pending = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            startActivityAndCollapse(pending);
        } else {
            startActivityAndCollapse(intent);
        }
    }
}
