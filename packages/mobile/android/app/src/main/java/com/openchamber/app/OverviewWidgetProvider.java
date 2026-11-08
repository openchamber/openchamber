package com.openchamber.app;

import android.content.Context;
import android.widget.RemoteViews;

/** Sessions plus an attention count, in a medium tile. */
public class OverviewWidgetProvider extends BaseWidgetProvider {

    @Override
    protected RemoteViews build(Context context, WidgetSnapshot snapshot) {
        return WidgetRenderer.overview(context, snapshot);
    }
}
