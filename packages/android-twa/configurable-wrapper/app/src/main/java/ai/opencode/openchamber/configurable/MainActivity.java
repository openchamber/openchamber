package ai.opencode.openchamber.configurable;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageButton;

import androidx.activity.OnBackPressedCallback;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsServiceConnection;
import androidx.browser.customtabs.CustomTabsSession;
import androidx.browser.trusted.TrustedWebActivityIntent;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.android.material.snackbar.Snackbar;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;

public class MainActivity extends AppCompatActivity {

    private static final String TAG = "MainActivity";
    private WebView webView;
    private ImageButton settingsButton;
    private View rootView;

    private ValueCallback<Uri[]> filePathCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;

    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;

    private PermissionRequest webPermissionRequest;

    private String pendingNotificationCallbackId;
    private static final String NOTIFICATION_JS_OBJECT = "AndroidNotificationBridge";
    private static final String PREFS_NOTIFICATION_ASKED = "notification_permission_asked";

    private CustomTabsSession customTabsSession;
    private CustomTabsServiceConnection customTabsServiceConnection;
    private boolean twaLaunched = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        androidx.core.splashscreen.SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);

        String url = getSavedUrl();
        if (url == null || url.isEmpty()) {
            startActivity(new Intent(this, SettingsActivity.class));
            finish();
            return;
        }

        setContentView(R.layout.activity_main);
        rootView = findViewById(android.R.id.content);

        webView = findViewById(R.id.webview);
        settingsButton = findViewById(R.id.settings_button);

        launchTwa(url);
        setupSettingsButton();
        setupBackPressed();
        setupActivityResultLaunchers();
    }

    private String getSavedUrl() {
        SharedPreferences prefs = getSharedPreferences(App.PREFS_NAME, MODE_PRIVATE);
        return prefs.getString(App.KEY_SERVER_URL, null);
    }

    private void launchTwa(String url) {
        Uri uri = Uri.parse(url);

        customTabsServiceConnection = new CustomTabsServiceConnection() {
            @Override
            public void onCustomTabsServiceConnected(ComponentName name, CustomTabsClient client) {
                customTabsSession = client.newSession(null);
                launchTrustedWebActivity(uri);
            }

            @Override
            public void onServiceDisconnected(ComponentName name) {
                customTabsSession = null;
            }
        };

        String packageName = CustomTabsClient.getPackageName(this, null);
        if (packageName != null) {
            boolean bound = CustomTabsClient.bindCustomTabsService(
                    this, packageName, customTabsServiceConnection);
            if (!bound) {
                Log.w(TAG, "Custom Tabs service not available, falling back to WebView");
                showWebView(url);
            }
        } else {
            Log.w(TAG, "No Custom Tabs provider found, falling back to WebView");
            showWebView(url);
        }
    }

    private void launchTrustedWebActivity(Uri uri) {
        if (customTabsSession == null) {
            Log.w(TAG, "No Custom Tabs session, falling back to WebView");
            String url = getSavedUrl();
            if (url != null) {
                showWebView(url);
            }
            return;
        }

        try {
            TrustedWebActivityIntentBuilder builder = new TrustedWebActivityIntentBuilder(uri)
                    .setToolbarColor(Color.parseColor("#151313"))
                    .setNavigationBarColor(Color.parseColor("#151313"));

            TrustedWebActivityIntent twaIntent = builder.build(customTabsSession);
            twaIntent.launchTrustedWebActivity(this);
            twaLaunched = true;
            finishAfterTransition();
        } catch (Exception e) {
            Log.w(TAG, "TWA launch failed, falling back to WebView", e);
            String url = getSavedUrl();
            if (url != null) {
                showWebView(url);
            }
        }
    }

    private void showWebView(String url) {
        webView.setVisibility(View.VISIBLE);
        setupWebView(url);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView(String url) {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new NotificationBridge(), NOTIFICATION_JS_OBJECT);

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Set<String> allowedOrigins = Collections.singleton("*");
            WebViewCompat.addDocumentStartJavaScript(webView, getNotificationBridgeJs(), allowedOrigins);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String pageUrl, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, pageUrl, favicon);
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    view.evaluateJavascript(getNotificationBridgeJs(), null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String savedUrl = getSavedUrl();
                if (savedUrl != null) {
                    Uri savedUri = Uri.parse(savedUrl);
                    Uri reqUri = request.getUrl();
                    if (reqUri.getHost() != null && reqUri.getHost().equals(savedUri.getHost())) {
                        return false;
                    }
                }
                Intent intent = new Intent(Intent.ACTION_VIEW, request.getUrl());
                startActivity(intent);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String pageUrl) {
                super.onPageFinished(view, pageUrl);
                view.evaluateJavascript(getNotificationBridgeJs(), null);
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    Snackbar.make(rootView, R.string.connection_error, Snackbar.LENGTH_LONG)
                            .setAction(R.string.settings_title, v -> openSettings())
                            .show();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) {
                geoCallback = callback;
                geoOrigin = origin;
                if (ContextCompat.checkSelfPermission(MainActivity.this,
                        Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                } else {
                    ActivityCompat.requestPermissions(MainActivity.this,
                            new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, 100);
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new androidx.appcompat.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new androidx.appcompat.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    fileChooserLauncher.launch(intent);
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                String[] resources = request.getResources();
                List<String> granted = new ArrayList<>();
                for (String r : resources) {
                    if (r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                            || r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        if (ContextCompat.checkSelfPermission(MainActivity.this,
                                Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                            && ContextCompat.checkSelfPermission(MainActivity.this,
                                Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            granted.add(r);
                        } else {
                            webPermissionRequest = request;
                            ActivityCompat.requestPermissions(MainActivity.this,
                                    new String[]{Manifest.permission.CAMERA,
                                            Manifest.permission.RECORD_AUDIO}, 300);
                            return;
                        }
                    } else {
                        granted.add(r);
                    }
                }
                request.grant(granted.toArray(new String[0]));
            }
        });

        webView.loadUrl(url);
    }

    private void setupSettingsButton() {
        settingsButton.setOnClickListener(v -> openSettings());
    }

    private void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    private void setupBackPressed() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    onBackPressed();
                }
            }
        });
    }

    private void setupActivityResultLaunchers() {
        fileChooserLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (filePathCallback == null) return;
                    Uri[] results = null;
                    if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                        Uri uri = result.getData().getData();
                        if (uri != null) {
                            results = new Uri[]{uri};
                        }
                    }
                    filePathCallback.onReceiveValue(results);
                    filePathCallback = null;
                }
        );
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 100 && geoCallback != null) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            geoCallback.invoke(geoOrigin, granted, false);
            geoCallback = null;
        } else if (requestCode == 200) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            String result = granted ? "granted" : "denied";
            String cbId = pendingNotificationCallbackId;
            pendingNotificationCallbackId = null;
            if (cbId != null && webView != null) {
                webView.evaluateJavascript(
                        "window.Notification._onResult('" + cbId + "','" + result + "');", null);
            }
        } else if (requestCode == 300 && webPermissionRequest != null) {
            boolean allGranted = grantResults.length > 0;
            for (int r : grantResults) {
                if (r != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            if (allGranted) {
                webPermissionRequest.grant(webPermissionRequest.getResources());
            } else {
                webPermissionRequest.deny();
            }
            webPermissionRequest = null;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Only intercept for pre-API 33 (Settings flow). API 33+ uses onRequestPermissionsResult.
        if (Build.VERSION.SDK_INT < 33 && pendingNotificationCallbackId != null && webView != null) {
            String cbId = pendingNotificationCallbackId;
            pendingNotificationCallbackId = null;
            boolean enabled = NotificationManagerCompat.from(this).areNotificationsEnabled();
            String result = enabled ? "granted" : "denied";
            webView.evaluateJavascript(
                    "window.Notification._onResult('" + cbId + "','" + result + "');", null);
        }
        String currentUrl = getSavedUrl();
        if (currentUrl != null && webView != null && webView.getVisibility() == View.VISIBLE) {
            String loadedUrl = webView.getUrl();
            if (loadedUrl == null || !loadedUrl.startsWith(currentUrl.replaceAll("/$", ""))) {
                webView.loadUrl(currentUrl);
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (customTabsServiceConnection != null) {
            try {
                unbindService(customTabsServiceConnection);
            } catch (Exception ignored) {}
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (pendingNotificationCallbackId != null) {
            outState.putString("pendingNotificationCallbackId", pendingNotificationCallbackId);
        }
    }

    @Override
    protected void onRestoreInstanceState(@NonNull Bundle savedInstanceState) {
        super.onRestoreInstanceState(savedInstanceState);
        pendingNotificationCallbackId = savedInstanceState.getString("pendingNotificationCallbackId");
    }

    public class NotificationBridge {
        @JavascriptInterface
        public String getPermission() {
            if (NotificationManagerCompat.from(MainActivity.this).areNotificationsEnabled()) {
                return "granted";
            }
            if (Build.VERSION.SDK_INT >= 33) {
                SharedPreferences prefs = getSharedPreferences(App.PREFS_NAME, MODE_PRIVATE);
                if (prefs.getBoolean(PREFS_NOTIFICATION_ASKED, false)) {
                    return "denied";
                }
                return "default";
            }
            return "default";
        }

        @JavascriptInterface
        public void showNotification(String title, String body) {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(MainActivity.this,
                    Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
            android.app.NotificationManager notificationManager =
                    (android.app.NotificationManager) getSystemService(android.content.Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.NotificationChannel channel = new android.app.NotificationChannel(
                        "openchamber_channel",
                        "OpenChamber Notifications",
                        android.app.NotificationManager.IMPORTANCE_DEFAULT);
                notificationManager.createNotificationChannel(channel);
            }
            android.app.Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new android.app.Notification.Builder(MainActivity.this, "openchamber_channel");
            } else {
                builder = new android.app.Notification.Builder(MainActivity.this);
            }
            Intent intent = new Intent(MainActivity.this, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            android.app.PendingIntent pendingIntent = android.app.PendingIntent.getActivity(MainActivity.this, 0, intent, android.app.PendingIntent.FLAG_IMMUTABLE);
            builder.setContentIntent(pendingIntent);
            builder.setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setAutoCancel(true);
            notificationManager.notify((int) System.currentTimeMillis(), builder.build());
        }

        @JavascriptInterface
        public void requestPermission(String callbackId) {
            runOnUiThread(() -> {
                if (NotificationManagerCompat.from(MainActivity.this).areNotificationsEnabled()) {
                    webView.evaluateJavascript(
                            "window.Notification._onResult('" + callbackId + "','granted');", null);
                    return;
                }
                if (pendingNotificationCallbackId != null) {
                    webView.evaluateJavascript(
                            "window.Notification._onResult('" + callbackId + "','denied');", null);
                    return;
                }
                pendingNotificationCallbackId = callbackId;
                if (Build.VERSION.SDK_INT >= 33) {
                    SharedPreferences.Editor editor = getSharedPreferences(App.PREFS_NAME, MODE_PRIVATE).edit();
                    editor.putBoolean(PREFS_NOTIFICATION_ASKED, true);
                    editor.apply();
                    ActivityCompat.requestPermissions(MainActivity.this,
                            new String[]{Manifest.permission.POST_NOTIFICATIONS}, 200);
                } else {
                    openNotificationSettings();
                }
            });
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                       .setData(Uri.fromParts("package", getPackageName(), null));
            }
            startActivity(intent);
        }
    }

    private String getNotificationBridgeJs() {
        return "(function() {"
            + "  if (window._notificationBridgeInstalled) return;"
            + "  window._notificationBridgeInstalled = true;"
            + "  var bridge = " + NOTIFICATION_JS_OBJECT + ";"
            + "  var ShimNotification = function(title, options) {"
            + "    var body = options ? options.body : ''; bridge.showNotification(title, body);"
            + "  };"
            + "  Object.defineProperty(ShimNotification, 'permission', {"
            + "    get: function() { return bridge.getPermission(); },"
            + "    configurable: true"
            + "  });"
            + "  ShimNotification.requestPermission = function() {"
            + "    return new Promise(function(resolve) {"
            + "      var perm = bridge.getPermission();"
            + "      if (perm === 'granted') { resolve('granted'); return; }"
            + "      var cbId = 'cb_' + Date.now() + '_' + Math.random().toString(36).substr(2,9);"
            + "      window._notifCbs = window._notifCbs || {};"
            + "      window._notifCbs[cbId] = resolve;"
            + "      bridge.requestPermission(cbId);"
            + "    });"
            + "  };"
            + "  ShimNotification._onResult = function(cbId, result) {"
            + "    if (window._notifCbs && window._notifCbs[cbId]) {"
            + "      window._notifCbs[cbId](result);"
            + "      delete window._notifCbs[cbId];"
            + "    }"
            + "  };"
            + "  Object.defineProperty(window, 'Notification', {"
            + "    value: ShimNotification,"
            + "    writable: true,"
            + "    configurable: true"
            + "  });"
            + "  window.dispatchEvent(new Event('notificationbridgeinstalled'));"
            + "})();";
    }
}
