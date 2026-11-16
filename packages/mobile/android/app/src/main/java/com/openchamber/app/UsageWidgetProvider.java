package com.openchamber.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;

public class UsageWidgetProvider extends AppWidgetProvider {
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
        // The bars are drawn at the widget's width, so a resize redraws the list.
        manager.updateAppWidget(widgetId, WidgetRenderer.render(context, true, widgetId));
        manager.notifyAppWidgetViewDataChanged(new int[] { widgetId }, R.id.widget_usage_list);
    }

    @Override
    public void onDisabled(Context context) {
        WidgetBridgePlugin.notifyWidgetsChanged();
    }
}
