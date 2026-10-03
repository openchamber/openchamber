import CryptoKit
import Foundation
import UserNotifications
import WidgetKit

/// Runs on every incoming push that carries `mutable-content: 1` — even when the app is closed
/// — and refreshes the widgets' shared snapshot so the home/lock-screen attention count and
/// unread dot stay current without the app having to foreground. It makes NO network calls:
/// it reads the count the server already put in `aps.badge` and the `sessionId` from the push,
/// updates the App Group snapshot the app wrote, and reloads the widget timelines. The app
/// still overwrites the snapshot with the authoritative full list on its next foreground.
class NotificationService: UNNotificationServiceExtension {
    private static let appGroup = "group.com.openchamber.app"
    private static let snapshotKey = "widgetSnapshot"

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        self.bestAttempt = request.content.mutableCopy() as? UNMutableNotificationContent

        refreshWidgetSnapshot(from: request)
        if let content = bestAttempt {
            openSealedText(into: content, from: request)
        }

        contentHandler(bestAttempt ?? request.content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = contentHandler {
            handler(bestAttempt ?? UNNotificationContent())
        }
    }

    /// A push from a server that knows this phone's key carries its real title and body
    /// sealed in `enc` (AES-256-GCM, `v1.` + base64 of nonce||ciphertext||tag) and only a
    /// generic title in the clear, so the relay, Apple and Google never read them. Opens it
    /// with the key the app keeps in the App Group; on any failure the generic text stays.
    private func openSealedText(into content: UNMutableNotificationContent, from request: UNNotificationRequest) {
        guard let sealed = request.content.userInfo["enc"] as? String,
              sealed.hasPrefix("v1."),
              let combined = Data(base64Encoded: String(sealed.dropFirst(3))),
              let keyText = UserDefaults(suiteName: Self.appGroup)?.string(forKey: "pushSealKey"),
              let keyData = Data(base64Encoded: keyText), keyData.count == 32,
              let box = try? AES.GCM.SealedBox(combined: combined),
              let plaintext = try? AES.GCM.open(box, using: SymmetricKey(data: keyData)),
              let opened = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any] else {
            return
        }
        if let title = opened["title"] as? String, !title.isEmpty {
            content.title = title
        }
        if let body = opened["body"] as? String {
            content.body = body
        }
    }

    private func refreshWidgetSnapshot(from request: UNNotificationRequest) {
        guard let defaults = UserDefaults(suiteName: Self.appGroup) else { return }

        var snapshot: [String: Any] = [
            "runtimeKey": request.content.userInfo["runtimeKey"] as? String ?? "",
            "attentionCount": 0,
            "recentSessions": [],
        ]
        if let json = defaults.string(forKey: Self.snapshotKey),
           let data = json.data(using: .utf8),
           let stored = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            snapshot = stored
        }

        if let pushRuntimeKey = request.content.userInfo["runtimeKey"] as? String,
           !pushRuntimeKey.isEmpty,
           snapshot["runtimeKey"] as? String != pushRuntimeKey {
            snapshot = [
                "runtimeKey": pushRuntimeKey,
                "attentionCount": 0,
                "recentSessions": [],
            ]
        }

        // Attention count: authoritative server value carried in aps.badge.
        if let badge = request.content.badge as? Int {
            snapshot["attentionCount"] = badge
        }

        // Mark the pushed session unread in the existing recent list (best-effort; the full
        // list/titles only refresh when the app next foregrounds).
        if let sessionId = request.content.userInfo["sessionId"] as? String,
           var sessions = snapshot["recentSessions"] as? [[String: Any]] {
            for index in sessions.indices where sessions[index]["id"] as? String == sessionId {
                sessions[index]["unread"] = true
            }
            snapshot["recentSessions"] = sessions
        }

        if let data = try? JSONSerialization.data(withJSONObject: snapshot),
           let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: Self.snapshotKey)
        }

        WidgetCenter.shared.reloadAllTimelines()
    }
}
