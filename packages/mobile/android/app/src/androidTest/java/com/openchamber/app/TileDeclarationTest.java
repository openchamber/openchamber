package com.openchamber.app;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Asks the system what it registered, not what the manifest says. A declaration in the wrong
 * place is silently ignored, and only the panel's own query reveals it: a tile is invisible to
 * the user unless PackageManager resolves it for QS_TILE.
 */
@RunWith(AndroidJUnit4.class)
public class TileDeclarationTest {

    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void theTileIsDiscoverableByTheQuickSettingsPanel() {
        Intent intent = new Intent("android.service.quicksettings.action.QS_TILE").setPackage(context.getPackageName());
        List<ResolveInfo> services = context.getPackageManager().queryIntentServices(intent, PackageManager.GET_META_DATA);

        boolean found = false;
        for (ResolveInfo info : services) {
            ServiceInfo service = info.serviceInfo;
            if (service != null && NewSessionTileService.class.getName().equals(service.name)) {
                found = true;
            }
        }
        assertTrue("the QS tile service is not declared: " + services, found);
    }
}
