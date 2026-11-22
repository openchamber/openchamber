package com.openchamber.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;

public class SessionsWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        WidgetRenderer.refresh(context);
        // A widget placed while the app runs gets its first snapshot right away.
        WidgetBridgePlugin.notifyWidgetsChanged();
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
                                         int widgetId, Bundle options) {
        super.onAppWidgetOptionsChanged(context, manager, widgetId, options);
        manager.updateAppWidget(widgetId, WidgetRenderer.render(context, false, widgetId));
    }

    @Override
    public void onDisabled(Context context) {
        WidgetBridgePlugin.notifyWidgetsChanged();
    }
}
