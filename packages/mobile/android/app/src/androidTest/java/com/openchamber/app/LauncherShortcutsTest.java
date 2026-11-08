package com.openchamber.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.content.res.XmlResourceParser;
import android.os.Bundle;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.xmlpull.v1.XmlPullParser;

/**
 * Pins the launcher quick actions ("New session", "Needs attention") to the deep links the web
 * layer routes. Nothing else verifies them: a dropped metadata entry, a renamed id or a broken
 * link only shows up at runtime, as an empty long-press menu or a tap that opens the default
 * screen, so this reads the packaged resources the system would read.
 */
@RunWith(AndroidJUnit4.class)
public class LauncherShortcutsTest {

    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";

    @Test
    public void shortcutsMetadataAndDeepLinksMatchTheQuickActions() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageManager packageManager = context.getPackageManager();

        // The launcher activity carries the metadata; the shortcut service does not read an
        // application-level copy.
        ComponentName launcher = new ComponentName(context.getPackageName(), MainActivity.class.getName());
        ActivityInfo info = packageManager.getActivityInfo(launcher, PackageManager.GET_META_DATA);
        Bundle metadata = info.metaData;
        assertNotNull(metadata);
        int shortcutsResource = metadata.getInt("android.app.shortcuts");
        assertEquals(R.xml.shortcuts, shortcutsResource);

        List<String> ids = new ArrayList<>();
        List<String> deepLinks = new ArrayList<>();
        XmlResourceParser parser = context.getResources().getXml(R.xml.shortcuts);
        try {
            int event = parser.getEventType();
            while (event != XmlPullParser.END_DOCUMENT) {
                if (event == XmlPullParser.START_TAG) {
                    if ("shortcut".equals(parser.getName())) {
                        ids.add(parser.getAttributeValue(ANDROID_NS, "shortcutId"));
                    } else if ("intent".equals(parser.getName())) {
                        deepLinks.add(parser.getAttributeValue(ANDROID_NS, "data"));
                    }
                }
                event = parser.next();
            }
        } finally {
            parser.close();
        }

        assertEquals(Arrays.asList("new-session", "attention"), ids);
        assertEquals(Arrays.asList(
            "openchamber://new-session",
            "openchamber://sessions?filter=attention"), deepLinks);

        Resources resources = context.getResources();
        assertFalse(resources.getString(R.string.shortcut_new_session).trim().isEmpty());
        assertFalse(resources.getString(R.string.shortcut_needs_attention).trim().isEmpty());
    }
}
