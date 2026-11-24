import Capacitor
import Foundation
import UIKit
import UserNotifications

/// Hands content shared from other apps (the OpenChamberShare extension, through
/// ShareInbox) to the page, the same contract as Android's SharedFilesPlugin:
/// `takePending` returns one share and keeps returning it until the page calls `accept`, so
/// a page reloaded before its draft holds the share takes it again. Shares wait in the App
/// Group until accepted and go to the page oldest first, one at a time: the next is chosen
/// only after the page accepts the one it holds, and the one whose notification the user
/// tapped goes last, so its draft is the one on screen. Registered in
/// BridgeViewController.capacitorDidLoad.
@objc(SharedFilesPlugin)
public class SharedFilesPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "SharedFilesPlugin"
    public let jsName = "SharedFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "takePending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "accept", returnType: CAPPluginReturnPromise),
    ]

    /// Every inbox read and all state below run here.
    private let queue = DispatchQueue(label: "com.openchamber.app.shared-files")
    private let inbox = ShareInbox.shared()
    /// Shares the page has been told about, so returning to the app does not announce them again.
    private var announced = Set<String>()
    private var focus: String?
    /// The share the page was handed and has not accepted. It is handed again until accepted,
    /// so a notification tap meanwhile cannot slip another share in ahead of it.
    private var handedId: String?
    /// Shares done with (accepted, or unreadable) whose folder could not be deleted. They are
    /// never handed out again, so they cannot hold up the shares behind them.
    private var settled = Set<String>()
    private var activeObserver: NSObjectProtocol?

    override public func load() {
        bridge?.notificationRouter.localNotificationHandler = self
        // A share made while the app was away; or one made from the app itself, which never
        // leaves the foreground, announced by the extension's Darwin notification.
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.announceNew()
        }
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                Unmanaged<SharedFilesPlugin>.fromOpaque(observer).takeUnretainedValue().announceNew()
            },
            ShareInbox.darwinNotification as CFString,
            nil,
            .deliverImmediately
        )
        queue.async { [inbox] in inbox?.sweepAbandoned(olderThan: 10 * 60) }
    }

    deinit {
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
    }

    private func announceNew() {
        queue.async {
            guard let ids = self.inbox?.pendingIds().filter({ !self.settled.contains($0) }),
                  ids.contains(where: { !self.announced.contains($0) }) else { return }
            self.announced.formUnion(ids)
            self.announcePending()
        }
    }

    /// Capacitor adds and removes listeners on the bridge's queue; the event goes out there too.
    private func announcePending() {
        guard let bridgeQueue = (bridge as? CapacitorBridge)?.dispatchQueue else { return }
        bridgeQueue.async { self.notifyListeners("pending", data: [:]) }
    }

    /// The share to hand over: the one the page holds, else the next in order.
    private func nextShare(in inbox: ShareInbox) -> StoredShare? {
        if let handedId, !settled.contains(handedId), let share = inbox.load(id: handedId) {
            return share
        }
        handedId = nil
        while let id = inbox.nextId(focus: focus, excluding: settled) {
            if let share = inbox.load(id: id) { return share }
            // `load` deleted an unreadable share; one it could not delete is skipped.
            settled.insert(id)
        }
        return nil
    }

    @objc func takePending(_ call: CAPPluginCall) {
        queue.async {
            guard let inbox = self.inbox else {
                call.resolve([:])
                return
            }
            guard let share = self.nextShare(in: inbox) else {
                call.resolve([:])
                return
            }
            self.handedId = share.id
            self.announced.insert(share.id)
            call.resolve(Self.payload(share))
        }
    }

    /// The page's draft holds the share: delete it and announce the next one, if any.
    @objc func accept(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("Missing id")
            return
        }
        queue.async {
            guard let inbox = self.inbox else {
                call.resolve()
                return
            }
            if !inbox.remove(id: id) { self.settled.insert(id) }
            if self.handedId == id { self.handedId = nil }
            if self.focus == id { self.focus = nil }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [ShareInbox.notificationId(for: id)])
            call.resolve()
            if inbox.nextId(focus: nil, excluding: self.settled) != nil {
                self.announcePending()
            }
        }
    }

    // MARK: Notifications

    /// Only the share extension posts local notifications. One that lands while the app is in
    /// front is not shown: the Darwin notification already brought the share in.
    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        []
    }

    public func didReceive(response: UNNotificationResponse) {
        guard let id = response.notification.request.content.userInfo[ShareInbox.notificationShareKey] as? String else { return }
        queue.async {
            self.focus = id
            self.announcePending()
        }
    }

    // MARK: Payload

    /// The shape `parseSharedFiles` reads. Each stored file is at most 10 MB, 32 MB per share.
    private static func payload(_ share: StoredShare) -> [String: Any] {
        var files: [[String: String]] = []
        var rejected = share.manifest.rejected.map { ["name": $0.name, "reason": $0.reason.rawValue] }
        for file in share.manifest.files {
            let url = share.directory.appendingPathComponent(file.stored)
            guard let data = try? Data(contentsOf: url), !data.isEmpty else {
                rejected.append(["name": file.name, "reason": ShareRefusal.unreadable.rawValue])
                continue
            }
            files.append(["name": file.name, "mimeType": file.mimeType, "data": data.base64EncodedString()])
        }
        var result: [String: Any] = ["id": share.id, "files": files, "rejected": rejected]
        if let text = share.manifest.text { result["text"] = text }
        return result
    }
}
