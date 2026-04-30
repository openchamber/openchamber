# Keep WebView related classes
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep application class
-keep class ai.opencode.openchamber.configurable.** { *; }

# Keep SharedPreferences
-keepclassmembers class * extends android.app.Application {
    <init>(...);
}
