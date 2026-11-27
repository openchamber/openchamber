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
 * Pins the launcher quick actions: "New session" to the deep link the web layer routes, and
 * "Dictate" to the unexported alias that is its only way in. Nothing else verifies them: a
 * dropped metadata entry, a renamed id or a broken link only shows up at runtime, as an empty long-press menu or a tap that opens the default
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
        List<String> targets = new ArrayList<>();
        XmlResourceParser parser = context.getResources().getXml(R.xml.shortcuts);
        try {
            int event = parser.getEventType();
            while (event != XmlPullParser.END_DOCUMENT) {
                if (event == XmlPullParser.START_TAG) {
                    if ("shortcut".equals(parser.getName())) {
                        ids.add(parser.getAttributeValue(ANDROID_NS, "shortcutId"));
                    } else if ("intent".equals(parser.getName())) {
                        deepLinks.add(parser.getAttributeValue(ANDROID_NS, "data"));
                        targets.add(parser.getAttributeValue(ANDROID_NS, "targetClass"));
                    }
                }
                event = parser.next();
            }
        } finally {
            parser.close();
        }

        assertEquals(Arrays.asList("new-session", "dictate"), ids);
        // Dictate carries no link: a link is something any app can open, and it must not start the mic.
        assertEquals(Arrays.asList("openchamber://new", null), deepLinks);
        assertEquals(Arrays.asList(MainActivity.class.getName(), DictateShortcut.ALIAS), targets);

        // The alias resolves to MainActivity and no other app can start it.
        ActivityInfo alias = packageManager.getActivityInfo(
            new ComponentName(context.getPackageName(), DictateShortcut.ALIAS), 0);
        assertEquals(MainActivity.class.getName(), alias.targetActivity);
        assertFalse(alias.exported);

        Resources resources = context.getResources();
        assertFalse(resources.getString(R.string.shortcut_new_session).trim().isEmpty());
        assertFalse(resources.getString(R.string.shortcut_dictate).trim().isEmpty());
    }
}
