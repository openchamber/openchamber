import Capacitor
import UIKit

/// Keep screen awake on iOS (packages/ui/src/hooks/useKeepScreenAwake.ts). WKWebView grants
/// `navigator.wakeLock` only inside a tap: Capacitor's web view answers WebKit's permission
/// query with "prompt", so a request made when a run starts or after a relaunch is denied.
/// The idle timer has no such rule. Registered in BridgeViewController.capacitorDidLoad.
@objc(KeepAwakePlugin)
public class KeepAwakePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KeepAwakePlugin"
    public let jsName = "KeepAwake"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
    ]

    @objc func setEnabled(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("Missing enabled")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
            call.resolve()
        }
    }
}
