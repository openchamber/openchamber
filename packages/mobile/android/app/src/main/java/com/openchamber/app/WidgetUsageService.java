package com.openchamber.app;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * The scrollable list of the Usage widget: provider headers, each followed by its windows.
 * Reads only the snapshot the app wrote; no network access and no credentials.
 */
public class WidgetUsageService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new UsageFactory(getApplicationContext(),
            intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID));
    }

    private static final class UsageFactory implements RemoteViewsFactory {
        private final Context context;
        private final int widgetId;
        private List<JSONObject> items = new ArrayList<>();
        private WidgetRenderer.Palette palette = new WidgetRenderer.Palette(null);

        UsageFactory(Context context, int widgetId) {
            this.context = context;
            this.widgetId = widgetId;
        }

        @Override public void onCreate() { onDataSetChanged(); }

        @Override public void onDataSetChanged() {
            JSONObject data = WidgetRenderer.snapshot(context, "usage");
            palette = new WidgetRenderer.Palette(data.optJSONObject("palette"));
            items = WidgetRenderer.usageItems(data);
        }

        @Override public void onDestroy() { items = new ArrayList<>(); }
        @Override public int getCount() { return items.size(); }
        @Override public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= items.size()) return null;
            JSONObject item = items.get(position);
            return WidgetRenderer.isUsageWindow(item)
                // Measured per row: a rotation changes the width without a data change.
                ? WidgetRenderer.renderUsageWindow(context, item, palette,
                    WidgetRenderer.usageBarWidthPx(context, widgetId))
                : WidgetRenderer.renderUsageProvider(context, item, palette);
        }
        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 2; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
    }
}
