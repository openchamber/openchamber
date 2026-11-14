import Foundation
import UserNotifications

/// Removes delivered notifications whose cause the server saw handled: the question answered,
/// the session continued or viewed on another device. The server names them in a `clear` key,
/// comma-separated, each as `tag@nid`: the push's tag (its collapse id) and the id of the
/// newest push under that tag the clearing covers. A newer notification with the same tag
/// stays, since a clearing push can arrive late. It arrives two ways: a background push that
/// shows nothing (AppDelegate), and on every later visible push (NotificationService), since
/// iOS may hold or drop background pushes. Compiled into the app and the notification service
/// extension.
enum PushClearing {
    struct Entry {
        let tag: String
        let notificationId: Int64?
    }

    static func entries(in userInfo: [AnyHashable: Any]) -> [Entry] {
        guard let list = userInfo["clear"] as? String else { return [] }
        return list.split(separator: ",").compactMap { item in
            let parts = item.split(separator: "@", maxSplits: 1).map(String.init)
            guard let tag = parts.first, !tag.isEmpty else { return nil }
            return Entry(tag: tag, notificationId: parts.count > 1 ? Int64(parts[1]) : nil)
        }
    }

    /// A delivered notification carries its tag and id in `tag` and `nid`; one sent directly
    /// to APNs also has the tag as its thread id.
    static func removeDelivered(_ entries: [Entry], completion: @escaping () -> Void) {
        guard !entries.isEmpty else {
            completion()
            return
        }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let identifiers = delivered
                .filter { notification in
                    let content = notification.request.content
                    let tag = (content.userInfo["tag"] as? String) ?? content.threadIdentifier
                    let shownId = (content.userInfo["nid"] as? String).flatMap { Int64($0) }
                    return entries.contains { entry in
                        guard entry.tag == tag else { return false }
                        guard let covered = entry.notificationId, let shownId else { return true }
                        return shownId <= covered
                    }
                }
                .map { $0.request.identifier }
            if !identifiers.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: identifiers)
            }
            completion()
        }
    }
}
