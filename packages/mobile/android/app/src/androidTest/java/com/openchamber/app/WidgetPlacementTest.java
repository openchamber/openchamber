package com.openchamber.app;

import static org.junit.Assert.assertTrue;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContentValues;
import android.graphics.Bitmap;
import android.net.Uri;
import android.provider.MediaStore;
import android.graphics.Canvas;
import android.graphics.Point;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.util.regex.Pattern;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Puts a widget on the home screen through the launcher, then asks the system whether it is bound.
 *
 * AppWidgetManager.getAppWidgetIds is the authority here: the picker listing a provider proves only
 * that the manifest was read, and a screenshot of an empty home screen proves nothing at all.
 */
@RunWith(AndroidJUnit4.class)
public class WidgetPlacementTest {

    private static final String TAG = "WidgetPlacement";

    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final StringBuilder report = new StringBuilder();
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void aWidgetLandsOnTheHomeScreen() throws Exception {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName provider = new ComponentName(context, OverviewWidgetProvider.class);
        note("pin supported: " + manager.isRequestPinAppWidgetSupported());

        if (!pin(manager, provider)) {
            dragFromPicker();
        }

        device.pressHome();
        SystemClock.sleep(2500);
        int[] ids = manager.getAppWidgetIds(provider);
        note("bound overview widgets: " + ids.length);
        capturePreview();
        publish("openchamber-home");
        if (ids.length == 0) {
            // Whatever is on screen now explains the failure, so keep it next to the report.
            device.dumpWindowHierarchy(new File(context.getFilesDir(), "home.xml"));
        }
        writeReport();
        assertTrue("the launcher bound no overview widget", ids.length > 0);
    }

    /** The system prompt a user confirms; the launcher answers by binding the widget itself. */
    private boolean pin(AppWidgetManager manager, ComponentName provider) throws Exception {
        if (!manager.isRequestPinAppWidgetSupported()) {
            return false;
        }
        if (!manager.requestPinAppWidget(provider, null, null)) {
            note("the launcher refused to pin the widget");
            return false;
        }
        // The prompt's button is "Add" or "ADD" depending on the launcher's casing.
        UiObject2 confirm = device.wait(
            Until.findObject(By.text(Pattern.compile("(?i)^add( to home screen)?$"))),
            8000
        );
        if (confirm == null) {
            note("no pin prompt appeared");
            device.dumpWindowHierarchy(new File(context.getFilesDir(), "pin-prompt.xml"));
            return false;
        }
        note("confirming the pin prompt");
        confirm.click();
        SystemClock.sleep(3000);
        // The launcher moves to the page it just placed the widget on, so this is the shot that
        // should show it; the home page afterwards is taken for comparison.
        publish("openchamber-widget-page");
        return true;
    }

    /** The older path: long-press a preview in the picker and drop it on the workspace. */
    private void dragFromPicker() {
        device.pressHome();
        SystemClock.sleep(1500);
        device.pressMenu();
        SystemClock.sleep(800);
        UiObject2 widgets = waitFor("Widgets", 5000);
        if (widgets == null) {
            note("no Widgets entry on the home menu");
            return;
        }
        widgets.click();
        SystemClock.sleep(2500);

        UiObject2 entry = scrollTo("OpenChamber", 8);
        if (entry == null) {
            note("OpenChamber is not in the picker");
            return;
        }
        entry.click();
        SystemClock.sleep(2500);

        UiObject2 preview = scrollTo("OpenChamber overview", 4);
        if (preview == null) {
            note("no overview preview");
            return;
        }
        note("dragging the preview at " + preview.getVisibleBounds());
        preview.drag(
            new Point(device.getDisplayWidth() / 2, (int) (device.getDisplayHeight() * 0.45)),
            400
        );
        SystemClock.sleep(2500);
    }

    /** Keeps the widget's own pixels, so the artifact shows what the launcher would draw. */
    private void capturePreview() throws Exception {
        RemoteViews views = WidgetRenderer.overview(context, WidgetSnapshotStore.read(context));
        final Bitmap bitmap = Bitmap.createBitmap(420, 220, Bitmap.Config.ARGB_8888);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            FrameLayout host = new FrameLayout(context);
            View inflated = views.apply(context, host);
            inflated.measure(
                View.MeasureSpec.makeMeasureSpec(420, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(220, View.MeasureSpec.EXACTLY)
            );
            inflated.layout(0, 0, 420, 220);
            inflated.draw(new Canvas(bitmap));
        });
        File out = new File(context.getFilesDir(), "widget-overview.png");
        try (FileOutputStream stream = new FileOutputStream(out)) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
        }
        note("wrote " + out + " (" + out.length() + " bytes)");
        publishBitmap(bitmap, "openchamber-widget");
    }

    /**
     * Saves the home screen into Pictures, not the app's own storage: the shell user cannot read
     * app-private files on this image, and a screenshot nobody can collect is not evidence.
     */
    private void publish(String name) {
        try {
            File shot = new File(context.getCacheDir(), name + ".png");
            device.takeScreenshot(shot);
            Bitmap screen = android.graphics.BitmapFactory.decodeFile(shot.getAbsolutePath());
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures");
            Uri uri = context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                note("could not publish the home screenshot");
                return;
            }
            try (java.io.OutputStream stream = context.getContentResolver().openOutputStream(uri)) {
                screen.compress(Bitmap.CompressFormat.PNG, 100, stream);
            }
            note("published " + name + " at " + uri);
        } catch (Exception error) {
            note("publishing the screenshot failed: " + error);
        }
    }

    private void publishBitmap(Bitmap bitmap, String name) {
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures");
            Uri uri = context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                note("could not publish " + name);
                return;
            }
            try (java.io.OutputStream stream = context.getContentResolver().openOutputStream(uri)) {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
            }
            note("published " + name + " at " + uri);
        } catch (Exception error) {
            note("publishing " + name + " failed: " + error);
        }
    }

    private void note(String line) {
        Log.i(TAG, line);
        report.append(line).append('\n');
    }

    private void writeReport() throws Exception {
        File out = new File(context.getFilesDir(), "placement-report.txt");
        try (PrintWriter writer = new PrintWriter(out)) {
            writer.print(report);
        }
    }

    private UiObject2 waitFor(String text, long timeout) {
        return device.wait(Until.findObject(By.textContains(text)), timeout);
    }

    private UiObject2 scrollTo(String text, int swipes) {
        UiObject2 found = waitFor(text, 2000);
        for (int attempt = 0; attempt < swipes && found == null; attempt++) {
            device.swipe(
                device.getDisplayWidth() / 2,
                (int) (device.getDisplayHeight() * 0.75),
                device.getDisplayWidth() / 2,
                (int) (device.getDisplayHeight() * 0.35),
                20
            );
            SystemClock.sleep(1200);
            found = waitFor(text, 2000);
        }
        return found;
    }
}
