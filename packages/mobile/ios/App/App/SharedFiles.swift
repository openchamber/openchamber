import Capacitor
import UIKit

/// Hands what the share sheet staged in the App Group inbox to the page: files to attach and
/// the link or paragraph to type in. Same take-once contract as ShortcutRequests: the inbox
/// waits for the page, so a cold launch, where the share opens the app before the page exists,
/// does not lose it.
@objc(SharedFilesPlugin)
public class SharedFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedFilesPlugin"
    public let jsName = "SharedFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "takePending", returnType: CAPPluginReturnPromise),
    ]
    private var observer: NSObjectProtocol?

    override public func load() {
        // The extension can fail to open the app (the responder-chain fallback is best
        // effort), so coming back to the foreground is the reliable moment to look again.
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.announceIfPending()
        }
        announceIfPending()
    }

    @objc func takePending(_ call: CAPPluginCall) {
        // Decoding a file to base64 can take a moment; the bridge is not a place to block.
        DispatchQueue.global(qos: .userInitiated).async {
            let result = ShareInbox.take()
            DispatchQueue.main.async {
                var payload: [String: Any] = ["files": result.files, "rejected": result.rejected]
                if let text = result.text { payload["text"] = text }
                call.resolve(payload)
            }
        }
    }

    private func announceIfPending() {
        guard ShareInbox.hasPending() else { return }
        notifyListeners("pending", data: [:])
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}
