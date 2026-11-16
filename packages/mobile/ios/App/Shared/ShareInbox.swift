import Foundation

/// The hand-off between the share extension and the app: a shared file is copied into the
/// App Group container, and the app reads and deletes it once the page asks for it. Both
/// targets compile this file, so the layout has one definition.
///
/// The container is a parameter rather than a constant so the tests can run in a temporary
/// directory: the test runner has no App Group entitlement, and a hard-coded container
/// would make every staging assertion untestable.
enum ShareInbox {
    struct Record: Codable {
        /// File name inside the inbox directory; empty for a file that was refused.
        let id: String
        let name: String
        let mimeType: String
        let size: Int
        /// Set when the file was not staged: the page reports the name instead of attaching it.
        let rejected: String?
    }

    /// What a share contains: files to attach and, for a shared link or paragraph, the text to
    /// type into the composer. One file describes both, so a share is read in one place.
    struct Manifest: Codable {
        let files: [Record]
        let text: String?
    }

    static let appGroup = "group.com.openchamber.app"
    static let directoryName = "SharedInbox"
    static let manifestName = "manifest.json"
    /// Opening this brings the app forward after a share. It carries no content: the page
    /// still has to take the files from the inbox, so a link cannot attach anything itself.
    static let openURL = URL(string: "openchamber://shared-file")!
    /// The most the bridge hands the page at once. A larger file is refused by name rather
    /// than failing halfway through the copy. The composer reads an attachment into the prompt
    /// below 10 MB and refuses it above, so a larger share is rejected here, before it is copied.
    static let maxFileBytes = 10 * 1024 * 1024
    /// The page holds every accepted file as base64 at the same time, so a batch is capped
    /// as well; the files past it are refused by name.
    static let maxBatchBytes = 32 * 1024 * 1024

    /// The App Group container, or nil when the current process has no entitlement for it.
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static func inbox(in container: URL) -> URL {
        container.appendingPathComponent(directoryName, isDirectory: true)
    }

    /// Replaces whatever the last share left, so the newest share is the one that arrives.
    static func resetDirectory() throws -> URL {
        guard let container else { throw ShareInboxError.noAppGroup }
        return try resetDirectory(in: container)
    }

    static func resetDirectory(in container: URL) throws -> URL {
        let directory = inbox(in: container)
        let manager = FileManager.default
        try? manager.removeItem(at: directory)
        removeStaleClaims(in: container)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /// A take that died between claiming the inbox and deleting its copy (the process was
    /// killed mid-copy) leaves a `SharedInbox-<uuid>` behind, and nothing else removes them.
    /// Only a claim older than an hour is swept: a younger one may still be read by a take.
    private static func removeStaleClaims(in container: URL) {
        let manager = FileManager.default
        let cutoff = Date().addingTimeInterval(-3600)
        let entries = (try? manager.contentsOfDirectory(
            at: container,
            includingPropertiesForKeys: [.contentModificationDateKey]
        )) ?? []
        for entry in entries where entry.lastPathComponent.hasPrefix("\(directoryName)-") {
            let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let modified, modified >= cutoff { continue }
            try? manager.removeItem(at: entry)
        }
    }

    static func write(_ records: [Record], text: String? = nil, in directory: URL) throws {
        let data = try JSONEncoder().encode(Manifest(files: records, text: text))
        try data.write(to: directory.appendingPathComponent(manifestName), options: .atomic)
    }

    static func hasPending() -> Bool {
        guard let container else { return false }
        return hasPending(in: container)
    }

    static func hasPending(in container: URL) -> Bool {
        FileManager.default.fileExists(atPath: inbox(in: container).appendingPathComponent(manifestName).path)
    }

    /// Files the page can attach, the ones that were refused when they were shared, and the
    /// text or link the user shared. The inbox is emptied either way: a share is delivered once.
    static func take() -> (files: [[String: Any]], rejected: [[String: String]], text: String?) {
        guard let container else { return ([], [], nil) }
        return take(in: container)
    }

    static func take(in container: URL) -> (files: [[String: Any]], rejected: [[String: String]], text: String?) {
        let source = inbox(in: container)
        // Claim the share by renaming the directory. The subscribe-time take and the
        // foreground announcement can race; the loser then finds no inbox instead of
        // delivering the same files twice.
        let claimed = container.appendingPathComponent("\(directoryName)-\(UUID().uuidString)", isDirectory: true)
        guard (try? FileManager.default.moveItem(at: source, to: claimed)) != nil else {
            return ([], [], nil)
        }
        defer { try? FileManager.default.removeItem(at: claimed) }

        guard let manifest = try? Data(contentsOf: claimed.appendingPathComponent(manifestName)),
              let share = try? JSONDecoder().decode(Manifest.self, from: manifest) else {
            return ([], [], nil)
        }
        let records = share.files

        var files: [[String: Any]] = []
        var rejected: [[String: String]] = []
        var batchBytes = 0
        for record in records {
            if let reason = record.rejected {
                rejected.append(["name": record.name, "reason": reason])
                continue
            }
            guard record.size <= maxFileBytes else {
                rejected.append(["name": record.name, "reason": "too-large"])
                continue
            }
            guard batchBytes + record.size <= maxBatchBytes else {
                rejected.append(["name": record.name, "reason": "batch-limit"])
                continue
            }
            guard let data = try? Data(contentsOf: claimed.appendingPathComponent(record.id)) else {
                rejected.append(["name": record.name, "reason": "unreadable"])
                continue
            }
            batchBytes += record.size
            files.append([
                "name": record.name,
                "mimeType": record.mimeType,
                "data": data.base64EncodedString(),
            ])
        }
        NSLog(
            "[ShareInbox] took files=%d rejected=%d text=%d names=%@",
            files.count,
            rejected.count,
            share.text?.count ?? 0,
            records.map { "\($0.name) (\($0.mimeType), \($0.size))" }.joined(separator: ", ")
        )
        return (files, rejected, share.text)
    }
}

enum ShareInboxError: Error {
    case noAppGroup
    case noContent
}
