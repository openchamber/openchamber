import UIKit
import Capacitor
import UserNotifications
import WidgetKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // Forward APNs registration to Capacitor so @capacitor/push-notifications can
    // deliver the device token / error to the JS `registration` / `registrationError`
    // listeners. Required because this app uses a custom AppDelegate (not the stock
    // Capacitor template, which already posts these notifications).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}

// iOS 26 (TN3187) requires apps built with the latest SDK to adopt the UIScene
// lifecycle. Capacitor 7's template still uses the legacy window setup, so we host a
// minimal scene delegate here that loads the Main storyboard (CAPBridgeViewController)
// and forwards deep links / universal links into Capacitor's delegate proxy.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        window.rootViewController = storyboard.instantiateInitialViewController()
        self.window = window
        window.makeKeyAndVisible()

        configureWebViewChrome()

        if let urlContext = connectionOptions.urlContexts.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: urlContext.url, options: [:])
        }
        if let userActivity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity) { _ in }
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // Re-assert in case the WebView wasn't ready at scene-connect time, or the
        // effect was re-enabled while backgrounded.
        configureWebViewChrome()

        // Clear the app-icon badge whenever the app becomes active. The server sends
        // an absolute badge count (sessions needing attention) on each push; once the
        // user is looking at the app, the in-app indicators take over, so reset to 0.
        if #available(iOS 17.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0)
        } else {
            UIApplication.shared.applicationIconBadgeNumber = 0
        }

        // Refresh the widgets' session overview now that the WebView is loaded and state is fresh.
        writeWidgetSnapshot()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        // Capture the latest session overview before the app leaves the foreground, so the
        // home/lock-screen/Control Center widgets reflect what the user just saw.
        writeWidgetSnapshot()
    }

    private static let widgetAppGroup = "group.com.openchamber.app"
    private static let widgetSnapshotKey = "widgetSnapshot"

    /// Pulls the session overview JSON from the web layer (window.__OPENCHAMBER_WIDGET_SNAPSHOT__),
    /// stores it in the shared App Group, and reloads the widget timelines. localStorage/stores
    /// aren't reachable from the widget process, so this is how the bundled UI feeds the widgets —
    /// no server involved. Failures are ignored so a transient read never clobbers a good snapshot.
    private func writeWidgetSnapshot() {
        guard let bridge = window?.rootViewController as? CAPBridgeViewController,
              let webView = bridge.webView else { return }
        let js = "(typeof window.__OPENCHAMBER_WIDGET_SNAPSHOT__ === 'function') ? window.__OPENCHAMBER_WIDGET_SNAPSHOT__() : null"
        webView.evaluateJavaScript(js) { result, _ in
            guard let json = result as? String, !json.isEmpty,
                  let defaults = UserDefaults(suiteName: SceneDelegate.widgetAppGroup) else { return }
            // Only write + reload when the overview actually changed. We write this on every
            // scene activate/resign; reloading WidgetCenter every time burns the WidgetKit
            // reload budget and leaves some widgets stale (the snapshot no longer contains a
            // per-call timestamp, so identical overviews compare equal).
            if defaults.string(forKey: SceneDelegate.widgetSnapshotKey) == json { return }
            defaults.set(json, forKey: SceneDelegate.widgetSnapshotKey)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// iOS 26 (Liquid Glass) automatically applies a "scroll edge effect" — a blur +
    /// appearance-coloured dim — to the top/bottom of a scroll view beneath the system
    /// bars. On the full-screen WKWebView that renders as a dark band behind the status
    /// bar in Dark Mode (independent of the in-app theme). Hide it so the web content
    /// (which paints its own themed background) is what shows under the status bar.
    private func configureWebViewChrome() {
        guard let bridge = window?.rootViewController as? CAPBridgeViewController,
              let webView = bridge.webView else { return }
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        if #available(iOS 26.0, *) {
            for key in ["topEdgeEffect", "bottomEdgeEffect"] {
                (webView.scrollView.value(forKey: key) as? UIView)?.isHidden = true
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let urlContext = URLContexts.first else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: urlContext.url, options: [:])
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity) { _ in }
    }
}
