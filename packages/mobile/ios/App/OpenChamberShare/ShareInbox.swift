import Foundation

// Content shared from other apps waits here until the page holds it in a draft. The share
// extension writes one directory per share into the App Group container; the app's
// SharedFiles plugin hands the shares to the page one at a time and deletes each once the
// page accepts it (packages/ui/src/lib/nativeSharedFiles.ts). Foundation only, compiled into
// the app and the extension, and tested on the Mac by scripts/share-inbox.test.mjs.

/// The same limits as Android's SharedPayloadStore and the composer.
enum ShareLimits {
    static let maxFiles = 8
    static let maxFileBytes: Int64 = 10 * 1024 * 1024
    static let maxBatchBytes: Int64 = 32 * 1024 * 1024
    static let perFileSeconds: TimeInterval = 15
    static let perShareSeconds: TimeInterval = 30
}

/// Reasons the page names in its "some files were skipped" toast (nativeSharedFiles.ts).
enum ShareRefusal: String, Codable {
    case tooLarge = "too-large"
    case batchLimit = "batch-limit"
    case tooMany = "too-many"
    case unsupportedType = "unsupported-type"
    case unreadable = "unreadable"
    case timedOut = "timed-out"
}

/// Running admission of one share's files, in the order they were shared.
struct ShareBudget {
    private(set) var acceptedBytes: Int64 = 0

    /// Items past the eighth are refused before anything is read.
    static func admits(index: Int) -> Bool {
        index < ShareLimits.maxFiles
    }

    mutating func admit(size: Int64) -> ShareRefusal? {
        if size <= 0 { return .unreadable }
        if size > ShareLimits.maxFileBytes { return .tooLarge }
        if acceptedBytes + size > ShareLimits.maxBatchBytes { return .batchLimit }
        acceptedBytes += size
        return nil
    }
}

struct ShareManifest: Codable, Equatable {
    struct File: Codable, Equatable {
        let name: String
        let mimeType: String
        /// File name inside the share's directory.
        let stored: String
    }

    struct Rejection: Codable, Equatable {
        let name: String
        let reason: ShareRefusal
    }

    var text: String?
    var files: [File]
    var rejected: [Rejection]
}

struct StoredShare {
    let id: String
    let manifest: ShareManifest
    let directory: URL
}

/// A share being written. Invisible to the app until `commit` renames it into place.
final class ShareDraft {
    let id: String
    let directory: URL
    private let destination: URL
    private let staging: URL
    private(set) var files: [ShareManifest.File] = []

    fileprivate init(id: String, directory: URL, destination: URL, staging: URL) {
        self.id = id
        self.directory = directory
        self.destination = destination
        self.staging = staging
    }

    /// Copies a file the extension was handed into the staging folder, never into memory.
    /// A copy that finishes after its item timed out stays out of the share: only `adopt`
    /// moves a staged file in.
    func stage(copying source: URL) throws -> URL {
        // A folder per copy, created now: the copy keeps its source's dates, so the sweep
        // ages the folder, never the file.
        let folder = staging.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let staged = folder.appendingPathComponent("file")
        try FileManager.default.copyItem(at: source, to: staged)
        return staged
    }

    func adopt(staged: URL, name: String, mimeType: String) throws {
        let stored = String(files.count)
        try FileManager.default.moveItem(at: staged, to: directory.appendingPathComponent(stored))
        try? FileManager.default.removeItem(at: staged.deletingLastPathComponent())
        files.append(.init(name: name, mimeType: mimeType, stored: stored))
    }

    func commit(text: String?, rejected: [ShareManifest.Rejection]) throws {
        let manifest = ShareManifest(text: text, files: files, rejected: rejected)
        let data = try JSONEncoder().encode(manifest)
        try data.write(to: directory.appendingPathComponent(ShareInbox.manifestName), options: .atomic)
        try FileManager.default.moveItem(at: directory, to: destination)
    }

    func discard() {
        try? FileManager.default.removeItem(at: directory)
    }
}

struct ShareInbox {
    static let appGroup = "group.com.openchamber.app"
    /// Posted by the extension after a commit, so an app in front picks the share up.
    static let darwinNotification = "com.openchamber.app.share-pending"
    static let manifestName = "manifest.json"
    private static let stagingName = ".staging"
    private static let removedPrefix = ".removed-"
    /// The share id rides in the notification's user info; the request id names the share too,
    /// so the app can take the notification down once the page holds the share.
    static let notificationShareKey = "openchamberShareId"

    static func notificationId(for shareId: String) -> String {
        "share-\(shareId)"
    }

    private static let partialSuffix = ".partial"

    let root: URL

    static func shared() -> ShareInbox? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            return nil
        }
        return ShareInbox(root: container.appendingPathComponent("SharedInbox", isDirectory: true))
    }

    /// Ids sort by creation time: milliseconds, zero-padded, then a random suffix.
    static func makeId(now: Date = Date()) -> String {
        let millis = Int64(now.timeIntervalSince1970 * 1000)
        return String(format: "%015lld-", millis) + UUID().uuidString.lowercased()
    }

    func begin(now: Date = Date()) throws -> ShareDraft {
        let id = Self.makeId(now: now)
        let directory = root.appendingPathComponent(id + Self.partialSuffix, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return ShareDraft(
            id: id,
            directory: directory,
            destination: root.appendingPathComponent(id, isDirectory: true),
            staging: root.appendingPathComponent(Self.stagingName, isDirectory: true)
        )
    }

    /// Committed shares, oldest first.
    func pendingIds() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return names.filter { !$0.hasPrefix(".") && !$0.hasSuffix(Self.partialSuffix) }.sorted()
    }

    /// The share to hand over next: the oldest, except that the one whose notification the
    /// user tapped goes last, so its draft is the one left on screen. `excluding` names shares
    /// already done with whose folder could not be deleted.
    func nextId(focus: String?, excluding: Set<String> = []) -> String? {
        let ids = pendingIds().filter { !excluding.contains($0) }
        return ids.first { $0 != focus } ?? ids.first
    }

    /// Reads a share; one whose manifest cannot be read is deleted, so it cannot hold up the
    /// shares behind it.
    func load(id: String) -> StoredShare? {
        let directory = root.appendingPathComponent(id, isDirectory: true)
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(Self.manifestName)),
              let manifest = try? JSONDecoder().decode(ShareManifest.self, from: data) else {
            remove(id: id)
            return nil
        }
        return StoredShare(id: id, manifest: manifest, directory: directory)
    }

    /// Takes a share out of the inbox. A folder that cannot be deleted is renamed out of the
    /// pending list instead, and swept later. False when the id is not a share's or neither
    /// worked.
    @discardableResult
    func remove(id: String) -> Bool {
        guard !id.isEmpty, !id.contains("/"), !id.hasPrefix("."), !id.hasSuffix(Self.partialSuffix) else { return false }
        let url = root.appendingPathComponent(id, isDirectory: true)
        if (try? FileManager.default.removeItem(at: url)) != nil { return true }
        if (try? FileManager.default.moveItem(at: url, to: root.appendingPathComponent(Self.removedPrefix + id))) != nil { return true }
        return !FileManager.default.fileExists(atPath: url.path)
    }

    /// Deletes shares an extension started and never committed (it was killed mid-copy),
    /// staged copies that finished after their item timed out, and accepted shares whose
    /// deletion failed earlier.
    func sweepAbandoned(olderThan age: TimeInterval, now: Date = Date()) {
        let staging = root.appendingPathComponent(Self.stagingName, isDirectory: true)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        for name in names where name.hasPrefix(Self.removedPrefix) {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(name))
        }
        let partial = names
            .filter { $0.hasSuffix(Self.partialSuffix) }
            .map { root.appendingPathComponent($0) }
        let staged = ((try? FileManager.default.contentsOfDirectory(atPath: staging.path)) ?? [])
            .map { staging.appendingPathComponent($0) }
        for url in partial + staged {
            let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast
            if now.timeIntervalSince(created) > age {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }
}
