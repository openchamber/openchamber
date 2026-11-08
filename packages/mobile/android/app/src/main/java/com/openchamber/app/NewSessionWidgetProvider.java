package com.openchamber.app;

import android.content.Context;
import android.widget.RemoteViews;

/** The smallest tile: tap anywhere to start a session. */
public class NewSessionWidgetProvider extends BaseWidgetProvider {

    @Override
    protected RemoteViews build(Context context, WidgetSnapshot snapshot) {
        return WidgetRenderer.newSession(context);
    }
}
