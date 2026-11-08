package com.openchamber.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Asks the system what it actually registered, not what the manifest says. The shortcuts taught
 * the lesson: a declaration in the wrong place is silently ignored, and only the system's own
 * list reveals it.
 */
@RunWith(AndroidJUnit4.class)
public class WidgetDeclarationTest {

    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void theLauncherOffersTheFourWidgets() {
        List<String> registered = new ArrayList<>();
        for (AppWidgetProviderInfo info : AppWidgetManager.getInstance(context).getInstalledProviders()) {
            if (context.getPackageName().equals(info.provider.getPackageName())) {
                registered.add(info.provider.getClassName());
            }
        }

        assertTrue("overview widget missing: " + registered, registered.contains(OverviewWidgetProvider.class.getName()));
        assertTrue("sessions widget missing: " + registered, registered.contains(SessionsWidgetProvider.class.getName()));
        assertTrue("quick actions widget missing: " + registered, registered.contains(QuickActionsWidgetProvider.class.getName()));
        assertTrue("new session widget missing: " + registered, registered.contains(NewSessionWidgetProvider.class.getName()));
        assertEquals("unexpected widget count: " + registered, 4, registered.size());
    }

    @Test
    public void eachWidgetHasASizeAndAPreviewLayout() {
        for (AppWidgetProviderInfo info : AppWidgetManager.getInstance(context).getInstalledProviders()) {
            if (!context.getPackageName().equals(info.provider.getPackageName())) {
                continue;
            }
            assertTrue(info.minWidth > 0 && info.minHeight > 0);
            assertNotNull("no initial layout for " + info.provider, info.initialLayout);
        }
    }

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

    @Test
    public void everyProviderListensForTheUpdateBroadcast() {
        Intent intent = new Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE).setPackage(context.getPackageName());
        List<ResolveInfo> receivers = context.getPackageManager().queryBroadcastReceivers(intent, 0);

        for (Class<?> provider : new Class<?>[] {
            OverviewWidgetProvider.class,
            SessionsWidgetProvider.class,
            QuickActionsWidgetProvider.class,
            NewSessionWidgetProvider.class,
        }) {
            String name = provider.getName();
            boolean found = false;
            for (ResolveInfo info : receivers) {
                if (info.activityInfo != null && name.equals(info.activityInfo.name)) {
                    found = true;
                    break;
                }
            }
            assertTrue(name + " does not receive APPWIDGET_UPDATE", found);
        }
    }
}
