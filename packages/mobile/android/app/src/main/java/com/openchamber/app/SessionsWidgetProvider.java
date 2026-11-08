package com.openchamber.app;

import android.content.Context;
import android.widget.RemoteViews;

/** The recent sessions list, with project names. */
public class SessionsWidgetProvider extends BaseWidgetProvider {

    @Override
    protected RemoteViews build(Context context, WidgetSnapshot snapshot) {
        return WidgetRenderer.sessions(context, snapshot);
    }
}
