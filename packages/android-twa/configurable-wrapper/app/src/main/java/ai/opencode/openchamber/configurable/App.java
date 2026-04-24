package ai.opencode.openchamber.configurable;

import android.app.Application;

public class App extends Application {
    public static final String PREFS_NAME = "openchamber_prefs";
    public static final String KEY_SERVER_URL = "server_url";
    public static final String KEY_URL_HISTORY = "url_history";
    public static final int MAX_HISTORY = 5;
    public static final String KEY_URL_HISTORY_VERSION = "url_history_version";

    @Override
    public void onCreate() {
        super.onCreate();
    }
}
