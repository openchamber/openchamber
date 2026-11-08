package com.openchamber.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * Renders one widget type and redraws every instance when the snapshot changes. The snapshot is
 * written by the app while it runs and by the push service while it does not, so there is nothing
 * to poll for; updatePeriodMillis is only a safety net for a phone that has been off for a while.
 */
public abstract class BaseWidgetProvider extends AppWidgetProvider {

    static final String ACTION_REFRESH = "com.openchamber.app.action.WIDGET_REFRESH";

    protected abstract RemoteViews build(Context context, WidgetSnapshot snapshot);

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        WidgetSnapshot snapshot = WidgetSnapshotStore.read(context);
        for (int id : ids) {
            manager.updateAppWidget(id, build(context, snapshot));
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (!ACTION_REFRESH.equals(intent.getAction())) {
            return;
        }
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        WidgetSnapshot snapshot = WidgetSnapshotStore.read(context);
        for (int id : manager.getAppWidgetIds(new ComponentName(context, getClass()))) {
            manager.updateAppWidget(id, build(context, snapshot));
        }
    }

    /** Redraws all four widget types; a broadcast per class keeps the providers independent. */
    static void refreshAll(Context context) {
        for (Class<?> provider : new Class<?>[] {
            OverviewWidgetProvider.class,
            SessionsWidgetProvider.class,
            QuickActionsWidgetProvider.class,
            NewSessionWidgetProvider.class,
        }) {
            Intent intent = new Intent(context, provider).setAction(ACTION_REFRESH);
            context.sendBroadcast(intent);
        }
    }
}
