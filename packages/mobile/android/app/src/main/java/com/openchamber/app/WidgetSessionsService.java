package com.openchamber.app;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * The scrollable list of the Sessions widget. Reads only the snapshot the app wrote;
 * no network access and no credentials.
 */
public class WidgetSessionsService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new SessionFactory(getApplicationContext());
    }

    private static final class SessionFactory implements RemoteViewsFactory {
        private final Context context;
        private List<JSONObject> entries = new ArrayList<>();
        private WidgetRenderer.Palette palette = new WidgetRenderer.Palette(null);
        private WidgetRenderer.Labels labels = new WidgetRenderer.Labels(null);

        SessionFactory(Context context) { this.context = context; }

        @Override public void onCreate() { onDataSetChanged(); }

        @Override public void onDataSetChanged() {
            JSONObject data = WidgetRenderer.snapshot(context, "sessions");
            palette = new WidgetRenderer.Palette(data.optJSONObject("palette"));
            labels = new WidgetRenderer.Labels(data.optJSONObject("labels"));
            entries = WidgetRenderer.sessionRows(data);
        }

        @Override public void onDestroy() { entries = new ArrayList<>(); }
        @Override public int getCount() { return entries.size(); }
        @Override public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= entries.size()) return null;
            return WidgetRenderer.renderSessionRow(context, entries.get(position), palette, labels);
        }
        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) {
            if (position < 0 || position >= entries.size()) return position;
            return entries.get(position).optString("id").hashCode();
        }
        @Override public boolean hasStableIds() { return true; }
    }
}
