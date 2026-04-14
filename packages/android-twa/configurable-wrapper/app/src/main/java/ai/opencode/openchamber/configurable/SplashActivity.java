package ai.opencode.openchamber.configurable;

import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;

import androidx.core.splashscreen.SplashScreen;
import androidx.appcompat.app.AppCompatActivity;

public class SplashActivity extends AppCompatActivity {

    private static final String DEFAULT_URL_META_KEY = "androidx.browser.customtabs.trusted.DEFAULT_URL";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(App.PREFS_NAME, MODE_PRIVATE);
        String savedUrl = prefs.getString(App.KEY_SERVER_URL, null);

        if (savedUrl == null || savedUrl.isEmpty()) {
            savedUrl = getDefaultUrlFromManifest();
            if (savedUrl != null && !savedUrl.isEmpty()) {
                prefs.edit().putString(App.KEY_SERVER_URL, savedUrl).apply();
            }
        }

        Intent intent;
        if (savedUrl == null || savedUrl.isEmpty()) {
            intent = new Intent(this, SettingsActivity.class);
        } else {
            intent = new Intent(this, MainActivity.class);
        }

        startActivity(intent);
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
        finish();
    }

    private String getDefaultUrlFromManifest() {
        try {
            ApplicationInfo ai = getPackageManager().getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA);
            if (ai.metaData != null) {
                return ai.metaData.getString(DEFAULT_URL_META_KEY);
            }
        } catch (PackageManager.NameNotFoundException ignored) {}
        return null;
    }
}
