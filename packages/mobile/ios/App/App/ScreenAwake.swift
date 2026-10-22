import Capacitor
import UIKit

/// Display retention only, scoped to the foreground app. It never wakes or unlocks iOS.
@objc(ScreenAwakePlugin)
public class ScreenAwakePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenAwakePlugin"
    public let jsName = "ScreenAwake"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
    ]
    private var enabled = false
    private var foreground = false
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let center = NotificationCenter.default
        foreground = bridge?.webView?.window?.windowScene?.activationState == .foregroundActive
        observers = [
            center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] notification in
                guard let self, let scene = notification.object as? UIWindowScene,
                      scene === self.bridge?.webView?.window?.windowScene else { return }
                self.foreground = true
                self.apply()
            },
            center.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] notification in
                guard let self, let scene = notification.object as? UIWindowScene,
                      scene === self.bridge?.webView?.window?.windowScene else { return }
                self.foreground = false
                self.apply()
            },
        ]
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        guard let requested = call.getBool("enabled") else {
            call.reject("enabled must be a boolean")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("Screen-awake plugin is unavailable")
                return
            }
            self.enabled = requested
            self.foreground = self.bridge?.webView?.window?.windowScene?.activationState == .foregroundActive
            self.apply()
            call.resolve()
        }
    }

    private func apply() {
        UIApplication.shared.isIdleTimerDisabled = enabled && foreground
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
    }
}
