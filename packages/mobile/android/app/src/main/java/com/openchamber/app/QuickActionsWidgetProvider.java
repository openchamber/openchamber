package com.openchamber.app;

import android.content.Context;
import android.widget.RemoteViews;

/** Two buttons: a new session and what needs attention. */
public class QuickActionsWidgetProvider extends BaseWidgetProvider {

    @Override
    protected RemoteViews build(Context context, WidgetSnapshot snapshot) {
        return WidgetRenderer.quickActions(context, snapshot);
    }
}
