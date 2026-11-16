package com.openchamber.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Renders the OpenChamber home-screen widgets from the snapshots the app writes
 * (WidgetBridgePlugin.update): the session overview the iOS widgets also read, and the
 * Usage page's quota readout. Colors come from the app's theme and text from the app's
 * language; both travel inside each snapshot.
 */
final class WidgetRenderer {
    private WidgetRenderer() {}

    static final String PREFS = "oc_sdk_widgets";
    private static final int MAX_SESSIONS = 10;

    /** Theme colors with the default OpenChamber theme as fallback. */
    static final class Palette {
        final boolean light;
        final int background;
        final int foreground;
        final int muted;
        final int primary;
        final int info;
        final int success;
        final int warning;
        final int error;

        Palette(JSONObject source) {
            JSONObject palette = source == null ? new JSONObject() : source;
            light = "light".equals(palette.optString("variant"));
            background = color(palette, "background", light ? 0xfff3f2f0 : 0xff1b1918);
            foreground = color(palette, "foreground", light ? 0xff44443d : 0xffdbd7cc);
            muted = color(palette, "muted", light ? 0xff696960 : 0xff89867c);
            primary = color(palette, "primary", light ? 0xffb35017 : 0xffda7c47);
            info = color(palette, "info", light ? 0xff2c6ebd : 0xff479fe6);
            success = color(palette, "success", light ? 0xff3f8a2c : 0xff76ad4f);
            warning = color(palette, "warning", light ? 0xffa86a0a : 0xffc67f13);
            error = color(palette, "error", light ? 0xffc0392b : 0xffda5b4a);
        }

        /** Background stepped toward the foreground, for controls on the widget surface. */
        int raised(float amount) { return blend(background, foreground, amount); }

        private static int color(JSONObject palette, String name, int fallback) {
            String hex = palette.optString(name, "");
            if (!hex.matches("^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")) return fallback;
            try { return Color.parseColor(hex.substring(0, 7)); }
            catch (IllegalArgumentException e) { return fallback; }
        }
    }

    /** Text from the app in its current language; English until the first snapshot arrives. */
    static final class Labels {
        private final JSONObject labels;
        Labels(JSONObject source) { labels = source == null ? new JSONObject() : source; }
        String get(String key, String fallback) {
            String value = labels.optString(key, "");
            return value.isEmpty() ? fallback : value;
        }
        String format(String key, String fallback, String value) {
            return get(key, fallback).replace("%s", value);
        }
    }

    static JSONObject snapshot(Context context, String key) {
        String saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, "{}");
        try { return new JSONObject(saved); } catch (Exception e) { return new JSONObject(); }
    }

    static boolean hasWidgets(Context context, Class<?> kind) {
        return AppWidgetManager.getInstance(context)
            .getAppWidgetIds(new ComponentName(context, kind)).length > 0;
    }

    static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] usage = manager.getAppWidgetIds(new ComponentName(context, UsageWidgetProvider.class));
        for (int id : usage) manager.updateAppWidget(id, render(context, true, id));
        if (usage.length > 0) manager.notifyAppWidgetViewDataChanged(usage, R.id.widget_usage_list);
        int[] sessions = manager.getAppWidgetIds(new ComponentName(context, SessionsWidgetProvider.class));
        for (int id : sessions) manager.updateAppWidget(id, render(context, false, id));
        if (sessions.length > 0) manager.notifyAppWidgetViewDataChanged(sessions, R.id.widget_sessions_list);
    }

    static RemoteViews render(Context context, boolean usage, int widgetId) {
        JSONObject data = snapshot(context, usage ? "usage" : "sessions");
        Palette palette = new Palette(data.optJSONObject("palette"));
        Labels labels = new Labels(data.optJSONObject("labels"));
        RemoteViews view = new RemoteViews(context.getPackageName(),
            usage ? R.layout.widget_usage : R.layout.widget_sessions);

        view.setInt(R.id.widget_bg, "setColorFilter", palette.background);
        view.setTextColor(R.id.widget_title, palette.foreground);
        view.setTextColor(R.id.widget_timestamp, palette.muted);
        view.setInt(R.id.widget_refresh_icon, "setColorFilter", palette.muted);
        view.setContentDescription(R.id.widget_refresh, labels.get("refresh", "Refresh"));
        view.setOnClickPendingIntent(R.id.widget_header, open(context,
            usage ? "openchamber://settings/usage" : "openchamber://sessions?filter=recent", widgetId * 100));

        // Refresh stays on the home screen: the receiver queues it and the app does the fetch.
        Intent refresh = new Intent(context, WidgetRefreshReceiver.class);
        refresh.setAction(WidgetRefreshReceiver.ACTION);
        view.setOnClickPendingIntent(R.id.widget_refresh,
            PendingIntent.getBroadcast(context, widgetId * 1000 + 77, refresh,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        if (usage) renderUsage(context, view, data, palette, labels, widgetId);
        else renderSessions(context, view, data, palette, labels, widgetId);
        view.setTextViewText(R.id.widget_timestamp, syncLabel(context, data, labels));
        return view;
    }

    private static String syncLabel(Context context, JSONObject data, Labels labels) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int requested = prefs.getInt("refresh_requested", 0);
        if (requested > prefs.getInt("refresh_acknowledged", 0)) {
            if (prefs.getInt("refresh_failed", 0) == requested) {
                return labels.get("failed", "Couldn't refresh. Check the connection");
            }
            return prefs.getBoolean("refresh_client_available", false)
                ? labels.get("refreshing", "Refreshing…")
                : labels.get("queued", "Open OpenChamber to refresh");
        }
        String updated = clean(data.optString("updated"), 40);
        return updated.isEmpty() ? context.getString(R.string.widget_open_to_sync)
            : labels.format("updated", "Updated %s", updated);
    }

    // MARK: Sessions

    private static void renderSessions(Context context, RemoteViews view, JSONObject data,
                                       Palette palette, Labels labels, int widgetId) {
        view.setTextViewText(R.id.widget_title, labels.get("sessionsTitle", "OpenChamber"));
        int attention = data.optInt("attentionCount", 0);
        view.setViewVisibility(R.id.widget_attention, attention > 0 ? View.VISIBLE : View.GONE);
        view.setTextViewText(R.id.widget_attention, String.valueOf(attention));
        view.setTextColor(R.id.widget_attention, palette.primary);

        view.setInt(R.id.widget_new_session_bg, "setColorFilter", palette.raised(0.12f));
        view.setInt(R.id.widget_new_session_icon, "setColorFilter", palette.foreground);
        view.setContentDescription(R.id.widget_new_session, labels.get("newSession", "New session"));
        view.setOnClickPendingIntent(R.id.widget_new_session,
            open(context, "openchamber://new", widgetId * 1000 + 99));

        // The list scrolls inside a RemoteViewsService; the header and footer stay put.
        Intent adapter = new Intent(context, WidgetSessionsService.class);
        adapter.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        adapter.setData(Uri.parse("openchamber://widget/sessions/" + widgetId));
        view.setRemoteAdapter(R.id.widget_sessions_list, adapter);
        view.setEmptyView(R.id.widget_sessions_list, R.id.widget_sessions_empty);
        view.setTextColor(R.id.widget_sessions_empty, palette.muted);
        if (data.has("recentSessions")) {
            view.setTextViewText(R.id.widget_sessions_empty, labels.get("sessionsEmpty", "No sessions yet"));
        }
        Intent template = new Intent(Intent.ACTION_VIEW, null, context, MainActivity.class);
        template.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        view.setPendingIntentTemplate(R.id.widget_sessions_list,
            PendingIntent.getActivity(context, widgetId * 1000 + 8, template,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE));
    }

    static List<JSONObject> sessionRows(JSONObject data) {
        ArrayList<JSONObject> rows = new ArrayList<>();
        JSONArray sessions = data.optJSONArray("recentSessions");
        if (sessions == null) return rows;
        for (int i = 0; i < sessions.length() && rows.size() < MAX_SESSIONS; i++) {
            JSONObject row = sessions.optJSONObject(i);
            if (row != null && !row.optString("id").isEmpty()) rows.add(row);
        }
        return rows;
    }

    /** One list row, matching the iOS Sessions widget: unread dot, title, project, live status. */
    static RemoteViews renderSessionRow(Context context, JSONObject item, Palette palette, Labels labels) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_session_row);
        boolean unread = item.optBoolean("unread", false);
        row.setImageViewResource(R.id.widget_session_dot, unread ? R.drawable.widget_dot : R.drawable.widget_ring);
        row.setInt(R.id.widget_session_dot, "setColorFilter",
            unread ? palette.primary : blend(palette.background, palette.muted, 0.6f));

        String title = clean(item.optString("title"), 120);
        String shown = title.isEmpty() ? labels.get("untitled", "Untitled session") : title;
        row.setTextViewText(R.id.widget_session_name, unread ? bold(shown) : shown);
        row.setTextColor(R.id.widget_session_name, palette.foreground);

        String project = clean(item.optString("project"), 60);
        row.setViewVisibility(R.id.widget_session_project, project.isEmpty() ? View.GONE : View.VISIBLE);
        row.setTextViewText(R.id.widget_session_project, project);
        row.setTextColor(R.id.widget_session_project, palette.muted);

        String status = item.optString("status");
        int statusColor = 0;
        String statusText = "";
        if ("running".equals(status)) { statusColor = palette.info; statusText = labels.get("running", "Running"); }
        else if ("retrying".equals(status)) { statusColor = palette.warning; statusText = labels.get("retrying", "Retrying"); }
        else if ("error".equals(status)) { statusColor = palette.error; statusText = labels.get("error", "Error"); }
        row.setViewVisibility(R.id.widget_session_status, statusText.isEmpty() ? View.GONE : View.VISIBLE);
        row.setTextViewText(R.id.widget_session_status, statusText);
        if (statusColor != 0) row.setTextColor(R.id.widget_session_status, statusColor);

        Intent fillIn = new Intent();
        fillIn.setData(Uri.parse("openchamber://session/" + Uri.encode(item.optString("id"))));
        row.setOnClickFillInIntent(R.id.widget_session_root, fillIn);
        return row;
    }

    private static CharSequence bold(String text) {
        android.text.SpannableString span = new android.text.SpannableString(text);
        span.setSpan(new android.text.style.StyleSpan(Typeface.BOLD), 0, text.length(), 0);
        return span;
    }

    // MARK: Usage

    private static void renderUsage(Context context, RemoteViews view, JSONObject data,
                                    Palette palette, Labels labels, int widgetId) {
        view.setTextViewText(R.id.widget_title, labels.get("usageTitle", "OpenChamber"));
        view.setTextColor(R.id.widget_subtitle, palette.muted);
        boolean known = data.has("providers");
        view.setTextViewText(R.id.widget_subtitle, !known ? "" : "used".equals(data.optString("mode"))
            ? labels.get("used", "used") : labels.get("remaining", "remaining"));

        // The list scrolls inside a RemoteViewsService; the header and footer stay put.
        Intent adapter = new Intent(context, WidgetUsageService.class);
        adapter.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        adapter.setData(Uri.parse("openchamber://widget/usage/" + widgetId));
        view.setRemoteAdapter(R.id.widget_usage_list, adapter);
        view.setEmptyView(R.id.widget_usage_list, R.id.widget_usage_empty);
        view.setTextColor(R.id.widget_usage_empty, palette.muted);
        if (known) view.setTextViewText(R.id.widget_usage_empty, labels.get("usageEmpty", "No usage to show"));
        Intent template = new Intent(Intent.ACTION_VIEW, null, context, MainActivity.class);
        template.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        view.setPendingIntentTemplate(R.id.widget_usage_list,
            PendingIntent.getActivity(context, widgetId * 1000 + 9, template,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE));
    }

    /** List items in order: each provider followed by its windows; windows carry their provider id. */
    static List<JSONObject> usageItems(JSONObject data) {
        ArrayList<JSONObject> items = new ArrayList<>();
        JSONArray providers = data.optJSONArray("providers");
        if (providers == null) return items;
        for (int i = 0; i < providers.length(); i++) {
            JSONObject provider = providers.optJSONObject(i);
            JSONArray windows = provider == null ? null : provider.optJSONArray("windows");
            if (windows == null || windows.length() == 0) continue;
            items.add(provider);
            for (int n = 0; n < windows.length(); n++) {
                JSONObject window = windows.optJSONObject(n);
                if (window == null) continue;
                try {
                    items.add(new JSONObject(window.toString()).put("providerId", provider.optString("id")));
                } catch (Exception ignored) {
                    // A window that cannot be copied is left out; the rest still show.
                }
            }
        }
        return items;
    }

    static boolean isUsageWindow(JSONObject item) {
        return item.has("providerId");
    }

    static RemoteViews renderUsageProvider(Context context, JSONObject provider, Palette palette) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_usage_provider);
        String id = provider.optString("id");
        String name = clean(provider.optString("name"), 48);
        row.setTextViewText(R.id.usage_provider_name, name);
        row.setTextColor(R.id.usage_provider_name, palette.foreground);
        // The provider logos are light marks, so the badge stays dark in both themes.
        int badge = palette.light ? blend(palette.foreground, palette.background, 0.1f) : palette.raised(0.1f);
        row.setInt(R.id.usage_provider_badge, "setColorFilter", badge);
        int logo = providerLogo(id);
        if (logo != 0) {
            row.setTextViewText(R.id.usage_provider_initial, "");
            row.setViewVisibility(R.id.usage_provider_logo, View.VISIBLE);
            row.setImageViewResource(R.id.usage_provider_logo, logo);
        } else {
            // Rows are reused while scrolling, so the previous provider's logo is cleared here.
            row.setViewVisibility(R.id.usage_provider_logo, View.GONE);
            row.setTextViewText(R.id.usage_provider_initial,
                name.isEmpty() ? "•" : name.substring(0, 1).toUpperCase(Locale.ROOT));
            row.setTextColor(R.id.usage_provider_initial, palette.light ? palette.background : palette.foreground);
        }
        row.setOnClickFillInIntent(R.id.usage_provider_root, providerLink(id));
        return row;
    }

    /** One window as the Usage page shows it: label and value, a bar, the reset time. */
    static RemoteViews renderUsageWindow(Context context, JSONObject window, Palette palette, int barWidthPx) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_usage_window);
        String label = clean(window.optString("label"), 60);
        String value = clean(window.optString("value"), 28);
        String reset = clean(window.optString("reset"), 60);
        row.setTextViewText(R.id.usage_window_label, labelWithReset(label, reset, palette.muted));
        row.setTextColor(R.id.usage_window_label, palette.foreground);
        row.setTextViewText(R.id.usage_window_value, value);
        row.setTextColor(R.id.usage_window_value, palette.foreground);
        row.setContentDescription(R.id.usage_window_root,
            label + ", " + value + (reset.isEmpty() ? "" : ", " + reset));
        double percent = window.optDouble("percent", Double.NaN);
        if (Double.isFinite(percent)) {
            String tone = window.optString("tone");
            int fill = "critical".equals(tone) ? palette.error : "warn".equals(tone) ? palette.warning : palette.success;
            row.setViewVisibility(R.id.usage_window_bar, View.VISIBLE);
            row.setImageViewBitmap(R.id.usage_window_bar, bar(context, barWidthPx, percent, fill, palette));
        } else {
            row.setViewVisibility(R.id.usage_window_bar, View.GONE);
        }
        row.setOnClickFillInIntent(R.id.usage_window_root, providerLink(window.optString("providerId")));
        return row;
    }

    /** "5-Hour  Resets 7:53 PM": the reset time follows the name in the muted color, smaller. */
    private static CharSequence labelWithReset(String label, String reset, int muted) {
        if (reset.isEmpty()) return label;
        android.text.SpannableString text = new android.text.SpannableString(label + "  " + reset);
        int start = label.length() + 2;
        text.setSpan(new android.text.style.ForegroundColorSpan(muted), start, text.length(), 0);
        text.setSpan(new android.text.style.RelativeSizeSpan(0.85f), start, text.length(), 0);
        return text;
    }

    private static Intent providerLink(String providerId) {
        Intent fillIn = new Intent();
        fillIn.setData(Uri.parse(providerId.isEmpty() ? "openchamber://settings/usage"
            : "openchamber://settings/usage?provider=" + Uri.encode(providerId)));
        return fillIn;
    }

    /** Width of a window row's bar, from the size the launcher gave this widget. */
    static int usageBarWidthPx(Context context, int widgetId) {
        Bundle options = AppWidgetManager.getInstance(context).getAppWidgetOptions(widgetId);
        // In portrait the widget is the minimum width the launcher reports, in landscape the maximum.
        boolean portrait = context.getResources().getConfiguration().orientation
            != android.content.res.Configuration.ORIENTATION_LANDSCAPE;
        int widthDp = options == null ? 0 : options.getInt(portrait
            ? AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH : AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
        if (widthDp <= 0) widthDp = 250;
        // Widget padding (14 + 10) and the row's own inset (30 + 4).
        float density = context.getResources().getDisplayMetrics().density;
        return Math.max(40, Math.round((widthDp - 58) * density));
    }

    private static Bitmap bar(Context context, int widthPx, double percent, int fill, Palette palette) {
        float density = context.getResources().getDisplayMetrics().density;
        int height = Math.max(4, Math.round(5 * density));
        Bitmap bitmap = Bitmap.createBitmap(widthPx, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        float radius = height / 2f;
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(palette.raised(0.14f));
        canvas.drawRoundRect(new RectF(0, 0, widthPx, height), radius, radius, paint);
        float filled = (float) (Math.min(100, Math.max(0, percent)) / 100.0 * widthPx);
        if (filled > 0) {
            paint.setColor(fill);
            // A sliver narrower than the bar's height still reads as a rounded dot.
            canvas.drawRoundRect(new RectF(0, 0, Math.max(filled, height), height), radius, radius, paint);
        }
        return bitmap;
    }

    private static int providerLogo(String id) {
        if (id.contains("antigravity")) return R.drawable.widget_logo_antigravity;
        if (id.contains("github-copilot")) return R.drawable.widget_logo_github_copilot;
        if (id.contains("codex")) return R.drawable.widget_logo_codex;
        if (id.contains("cursor")) return R.drawable.widget_logo_cursor;
        if (id.equals("google")) return R.drawable.widget_logo_google;
        if (id.equals("openai")) return R.drawable.widget_logo_openai;
        if (id.equals("claude")) return R.drawable.widget_logo_claude;
        return 0;
    }

    static int blend(int base, int accent, float weight) {
        float other = 1f - weight;
        return Color.rgb(
            Math.round(Color.red(base) * other + Color.red(accent) * weight),
            Math.round(Color.green(base) * other + Color.green(accent) * weight),
            Math.round(Color.blue(base) * other + Color.blue(accent) * weight));
    }

    static String clean(String raw, int limit) {
        String value = raw.replace('\n', ' ').replace('\r', ' ').trim();
        return value.length() > limit ? value.substring(0, limit - 1) + "…" : value;
    }

    private static PendingIntent open(Context context, String url, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url), context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
