import AppIntents
import Capacitor
import Foundation

// A new-session request from the Shortcuts app or Siri travels to the page through this
// app-local plugin, never through an `openchamber://` link: any app or web page can open a
// link, and a link must not be able to send a prompt to an agent. The request waits in the
// inbox until the page takes it (packages/ui/src/lib/nativeShortcutRequests.ts), so a cold
// launch, where the intent runs before the page has loaded, does not lose it.

/// Holds the latest request; the newest one wins, like a deep link. Main thread only.
enum ShortcutRequestInbox {
    static let pendingNotification = Notification.Name("OpenChamberShortcutRequestPending")
    private static var pending: [String: Any]?

    static func deliver(projectId: String?, text: String?) {
        var request: [String: Any] = [:]
        if let projectId, !projectId.isEmpty { request["projectId"] = projectId }
        if let text, !text.isEmpty { request["text"] = text }
        pending = request
        NotificationCenter.default.post(name: pendingNotification, object: nil)
    }

    static func take() -> [String: Any]? {
        defer { pending = nil }
        return pending
    }
}

/// Registered on the bridge in BridgeViewController.capacitorDidLoad. Announces a new request
/// with a bare `pending` event; the page then takes it, so it is handed out exactly once.
@objc(ShortcutRequestsPlugin)
public class ShortcutRequestsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShortcutRequestsPlugin"
    public let jsName = "ShortcutRequests"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "takePending", returnType: CAPPluginReturnPromise),
    ]
    private var observer: NSObjectProtocol?

    override public func load() {
        observer = NotificationCenter.default.addObserver(
            forName: ShortcutRequestInbox.pendingNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.notifyListeners("pending", data: [:])
        }
    }

    @objc func takePending(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let request = ShortcutRequestInbox.take() {
                call.resolve(["request": request])
            } else {
                call.resolve([:])
            }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}

// MARK: - Project picker

/// A project as the page last listed it in the widget snapshot (mobileWidgetSnapshot.ts).
private struct SnapshotProject: Decodable {
    let id: String
    let label: String
}

private struct SnapshotProjects: Decodable {
    var projects: [SnapshotProject]?
}

private enum ShortcutProjectStore {
    static func load() -> [SnapshotProject] {
        guard let defaults = UserDefaults(suiteName: "group.com.openchamber.app"),
              let json = defaults.string(forKey: "widgetSnapshot"),
              let data = json.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(SnapshotProjects.self, from: data) else {
            return []
        }
        return snapshot.projects ?? []
    }
}

@available(iOS 18.0, *)
struct ShortcutProjectEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Project"
    static let defaultQuery = ShortcutProjectQuery()

    let id: String
    let label: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(label)")
    }
}

@available(iOS 18.0, *)
struct ShortcutProjectQuery: EntityQuery {
    // The list is the one the app saw last time it was open. A saved shortcut keeps its
    // project even after the list changes: the page decides whether it still exists, and
    // opens an unsent draft when it does not, instead of sending somewhere else.
    func entities(for identifiers: [String]) async throws -> [ShortcutProjectEntity] {
        let projects = ShortcutProjectStore.load()
        return identifiers.map { id in
            ShortcutProjectEntity(id: id, label: projects.first { $0.id == id }?.label ?? id)
        }
    }

    func suggestedEntities() async throws -> [ShortcutProjectEntity] {
        ShortcutProjectStore.load().map { ShortcutProjectEntity(id: $0.id, label: $0.label) }
    }
}
