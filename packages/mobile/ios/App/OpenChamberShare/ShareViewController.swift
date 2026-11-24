import os
import UIKit
import UniformTypeIdentifiers
import UserNotifications

// The share extension. It has no screen of its own: it copies what was shared into the App
// Group inbox (ShareInbox) within the limits the page applies, then lets the user get to the
// app. iOS gives a share extension no supported way to open its app, so it posts a local
// notification whose tap opens OpenChamber, and shows a confirmation for a second, since a
// Focus can hold the banner back; with notifications off it shows a short alert instead, and
// the share waits for the next time the app opens. The app's SharedFiles plugin takes it from
// there. Logs carry counts and reasons, never a file name or a URL.

final class ShareViewController: UIViewController {
    private var started = false
    private let spinner = UIActivityIndicatorView(style: .large)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        spinner.startAnimating()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let caption = items.compactMap { $0.attributedContentText?.string }.first
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = ShareIntake.store(providers: providers, caption: caption)
            DispatchQueue.main.async { self.finish(outcome) }
        }
    }

    private func finish(_ outcome: ShareIntake.Outcome) {
        let strings = ShareStrings.forPreferredLanguages()
        switch outcome {
        case .nothing:
            complete()
        case .failed:
            alert(title: strings.failedTitle, message: nil, strings: strings)
        case .stored(let id, let tookSomething):
            CFNotificationCenterPostNotification(
                CFNotificationCenterGetDarwinNotifyCenter(),
                CFNotificationName(ShareInbox.darwinNotification as CFString),
                nil, nil, true
            )
            let center = UNUserNotificationCenter.current()
            center.getNotificationSettings { settings in
                let canAlert = settings.authorizationStatus == .authorized && settings.alertSetting == .enabled
                guard canAlert else {
                    DispatchQueue.main.async {
                        if tookSomething {
                            self.alert(title: strings.savedTitle, message: strings.savedMessage, strings: strings)
                        } else {
                            self.alert(title: strings.failedTitle, message: strings.failedMessage, strings: strings)
                        }
                    }
                    return
                }
                let content = UNMutableNotificationContent()
                content.body = tookSomething ? strings.openDraft : strings.nothingTaken
                content.threadIdentifier = "share"
                content.userInfo = [ShareInbox.notificationShareKey: id]
                let request = UNNotificationRequest(identifier: ShareInbox.notificationId(for: id), content: content, trigger: nil)
                center.add(request) { _ in
                    DispatchQueue.main.async {
                        self.confirm(tookSomething ? strings.savedTitle : strings.failedTitle, succeeded: tookSomething)
                    }
                }
            }
        }
    }

    /// A card that closes the sheet by itself after a second.
    private func confirm(_ title: String, succeeded: Bool) {
        spinner.stopAnimating()
        let card = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
        card.layer.cornerRadius = 20
        card.clipsToBounds = true
        card.translatesAutoresizingMaskIntoConstraints = false
        let icon = UIImageView(image: UIImage(systemName: succeeded ? "checkmark.circle.fill" : "exclamationmark.circle.fill"))
        icon.tintColor = succeeded ? .systemGreen : .systemOrange
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 36, weight: .semibold)
        let label = UILabel()
        label.text = title
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.numberOfLines = 0
        let stack = UIStackView(arrangedSubviews: [icon, label])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.contentView.addSubview(stack)
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 260),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            stack.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -24),
        ])
        card.alpha = 0
        UIView.animate(withDuration: 0.15) { card.alpha = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { self.complete() }
        UIAccessibility.post(notification: .announcement, argument: title)
    }

    private func alert(title: String, message: String?, strings: ShareStrings) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: strings.ok, style: .default) { _ in self.complete() })
        present(alert, animated: true)
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}

/// Reads one share into the inbox. Runs off the main thread and waits on each item in turn,
/// so a provider that never answers costs at most its own deadline.
enum ShareIntake {
    enum Outcome {
        /// Nothing was shared that could even be named.
        case nothing
        /// The inbox could not be written.
        case failed
        /// `tookSomething` is false when every item was refused.
        case stored(id: String, tookSomething: Bool)
    }

    private enum Kind {
        case file(UTType)
        case link
        case text
        case unsupported

        var type: UTType? {
            switch self {
            case .file(let type): return type
            case .link: return .url
            case .text: return .plainText
            case .unsupported: return nil
            }
        }
    }

    private static let log = Logger(subsystem: "com.openchamber.app.share", category: "intake")

    static func store(providers: [NSItemProvider], caption: String?) -> Outcome {
        guard let inbox = ShareInbox.shared(), let draft = try? inbox.begin() else {
            log.error("Share inbox unavailable")
            return .failed
        }
        let state = IntakeState(draft: draft)
        let deadline = Deadline(seconds: ShareLimits.perShareSeconds)
        var fileIndex = 0

        for provider in providers {
            let kind = classify(provider)
            if case .unsupported = kind {
                state.refuse(name: refusalName(provider, type: nil, deadline: deadline), .unsupportedType)
                continue
            }
            if case .file(let type) = kind {
                defer { fileIndex += 1 }
                guard ShareBudget.admits(index: fileIndex) else {
                    state.refuse(name: refusalName(provider, type: type, deadline: deadline), .tooMany)
                    continue
                }
            }
            guard deadline.remaining > 0 else {
                state.refuse(name: refusalName(provider, type: kind.type, deadline: deadline), .timedOut)
                continue
            }
            switch kind {
            case .file(let type):
                loadFile(provider, type: type, state: state, deadline: deadline)
            case .link, .text:
                loadTextual(provider, kind: kind, state: state, deadline: deadline, fileIndex: &fileIndex)
            case .unsupported:
                break
            }
        }

        let result = state.finish(caption: caption)
        guard result.hasContent else {
            draft.discard()
            return .nothing
        }
        do {
            try draft.commit(text: result.text, rejected: result.rejected)
        } catch {
            draft.discard()
            log.error("Share commit failed")
            return .failed
        }
        log.info("Stored share: text=\(result.text != nil) files=\(draft.files.count) rejected=\(result.rejected.count)")
        return .stored(id: draft.id, tookSomething: result.text != nil || !draft.files.isEmpty)
    }

    // MARK: Classification

    private static func classify(_ provider: NSItemProvider) -> Kind {
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        let isTextual = { (type: UTType) in type.conforms(to: .text) || type.conforms(to: .url) }
        if let type = types.first(where: { $0.conforms(to: .data) && !isTextual($0) }) {
            return .file(preferredImageType(in: types) ?? type)
        }
        // A text file from Files is still a file: its provider offers it open in place.
        if let type = provider.registeredContentTypesForOpenInPlace.first {
            return .file(type)
        }
        if types.contains(where: { $0.conforms(to: .url) }) { return .link }
        if types.contains(where: { $0.conforms(to: .text) }) { return .text }
        return .unsupported
    }

    /// Photos offers HEIC first; JPEG, when offered too, attaches without a conversion.
    private static func preferredImageType(in types: [UTType]) -> UTType? {
        guard types.contains(where: { $0.conforms(to: .heic) || $0.conforms(to: .heif) }) else { return nil }
        return types.first { $0.conforms(to: .jpeg) }
    }

    // MARK: Loading

    private static func itemWait(_ deadline: Deadline) -> TimeInterval {
        min(ShareLimits.perFileSeconds, deadline.remaining)
    }

    private static func loadFile(_ provider: NSItemProvider, type: UTType, state: IntakeState, deadline: Deadline) {
        let name = displayName(provider: provider, type: type, fallback: nil)
        let waiter = Waiter()
        let progress = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
            // The file exists only while this handler runs, so it is copied here, outside the
            // waiter's lock; a copy that ends after the deadline is thrown away.
            guard let url else {
                waiter.complete { state.refuse(name: name, .unreadable) }
                return
            }
            let named = displayName(provider: provider, type: type, fallback: url)
            let staged = state.stage(url)
            if !waiter.complete({ state.adopt(staged, name: named, mimeType: mimeType(type)) }) {
                state.discard(staged)
            }
        }
        if !waiter.wait(seconds: itemWait(deadline)) {
            progress.cancel()
            state.refuse(name: name, .timedOut)
        }
    }

    /// A link or text. Some providers hand over a file URL here instead, which then counts as
    /// a file against the same limits.
    private static func loadTextual(_ provider: NSItemProvider, kind: Kind, state: IntakeState, deadline: Deadline, fileIndex: inout Int) {
        let type: UTType = kind.type ?? .plainText
        // One 15-second window for the item, the URL and its copy together.
        let item = Deadline(seconds: itemWait(deadline))
        let waiter = Waiter()
        var fileURL: URL?
        provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in
            waiter.complete {
                switch item {
                case let url as URL where url.isFileURL:
                    fileURL = url
                case let url as URL:
                    state.add(text: url.absoluteString)
                case let text as String:
                    state.add(text: text)
                case let text as NSAttributedString:
                    state.add(text: text.string)
                case let data as Data:
                    if type.conforms(to: .url), let url = URL(dataRepresentation: data, relativeTo: nil) {
                        if url.isFileURL { fileURL = url } else { state.add(text: url.absoluteString) }
                    } else if let text = String(data: data, encoding: .utf8) {
                        state.add(text: text)
                    }
                default:
                    break
                }
            }
        }
        guard waiter.wait(seconds: item.remaining) else {
            state.refuse(name: displayName(provider: provider, type: type, fallback: nil), .timedOut)
            return
        }
        guard let fileURL else { return }
        defer { fileIndex += 1 }
        let fileType = UTType(filenameExtension: fileURL.pathExtension) ?? .data
        let name = displayName(provider: provider, type: fileType, fallback: fileURL)
        guard ShareBudget.admits(index: fileIndex) else {
            state.refuse(name: name, .tooMany)
            return
        }
        // The copy may have to fetch the file first (a cloud document), so it runs against
        // the same deadline as any other item.
        let copied = Waiter()
        DispatchQueue.global(qos: .userInitiated).async {
            let scoped = fileURL.startAccessingSecurityScopedResource()
            defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }
            let staged = state.stage(fileURL)
            if !copied.complete({ state.adopt(staged, name: name, mimeType: mimeType(fileType)) }) {
                state.discard(staged)
            }
        }
        if !copied.wait(seconds: item.remaining) {
            state.refuse(name: name, .timedOut)
        }
    }

    // MARK: Names

    /// The name of an item refused before it was read. A provider that shares a file by URL
    /// often has no suggested name, so the URL is asked for (the file itself is not opened),
    /// for at most two seconds and never past the share's deadline.
    private static func refusalName(_ provider: NSItemProvider, type: UTType?, deadline: Deadline) -> String {
        let wait = min(2, deadline.remaining)
        guard provider.suggestedName?.isEmpty != false,
              wait > 0,
              provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) else {
            return displayName(provider: provider, type: type, fallback: nil)
        }
        let waiter = Waiter()
        var url: URL?
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            waiter.complete { url = item as? URL }
        }
        return displayName(provider: provider, type: type, fallback: waiter.wait(seconds: wait) ? url : nil)
    }

    private static func mimeType(_ type: UTType) -> String {
        type.preferredMIMEType ?? "application/octet-stream"
    }

    static func displayName(provider: NSItemProvider, type: UTType?, fallback: URL?) -> String {
        if let suggested = provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines), !suggested.isEmpty {
            let safe = suggested.replacingOccurrences(of: "/", with: "_")
            guard (safe as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension else { return safe }
            return "\(safe).\(ext)"
        }
        if let last = fallback?.lastPathComponent, !last.isEmpty { return last }
        if let ext = type?.preferredFilenameExtension { return "file.\(ext)" }
        return "file"
    }
}

/// The share's 30 seconds, on the monotonic clock.
private struct Deadline {
    private let end: DispatchTime

    init(seconds: TimeInterval) {
        end = .now() + seconds
    }

    var remaining: TimeInterval {
        let now = DispatchTime.now().uptimeNanoseconds
        return end.uptimeNanoseconds > now ? Double(end.uptimeNanoseconds - now) / 1_000_000_000 : 0
    }
}

/// A file copied into the staging folder, or the reason it was not.
private enum Staged {
    case file(URL, size: Int64)
    case refused(ShareRefusal)
}

/// One share's progress. Provider callbacks and the reading thread meet here under a lock;
/// a callback that arrives after its item timed out changes nothing.
private final class IntakeState {
    private let lock = NSLock()
    private let draft: ShareDraft
    private var budget = ShareBudget()
    private var texts: [String] = []
    private var rejected: [ShareManifest.Rejection] = []

    init(draft: ShareDraft) {
        self.draft = draft
    }

    func refuse(name: String, _ reason: ShareRefusal) {
        lock.lock(); defer { lock.unlock() }
        rejected.append(.init(name: name, reason: reason))
    }

    func add(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        if !texts.contains(trimmed) { texts.append(trimmed) }
    }

    /// Copies a file no larger than one file may be; the batch limit is applied on `adopt`,
    /// in the order items finish.
    func stage(_ url: URL) -> Staged {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map(Int64.init) ?? 0
        if size <= 0 { return .refused(.unreadable) }
        if size > ShareLimits.maxFileBytes { return .refused(.tooLarge) }
        guard let staged = try? draft.stage(copying: url) else { return .refused(.unreadable) }
        return .file(staged, size: size)
    }

    func adopt(_ staged: Staged, name: String, mimeType: String) {
        lock.lock(); defer { lock.unlock() }
        switch staged {
        case .refused(let reason):
            rejected.append(.init(name: name, reason: reason))
        case .file(let url, let size):
            if let refusal = budget.admit(size: size) {
                try? FileManager.default.removeItem(at: url)
                rejected.append(.init(name: name, reason: refusal))
                return
            }
            do {
                try draft.adopt(staged: url, name: name, mimeType: mimeType)
            } catch {
                try? FileManager.default.removeItem(at: url)
                rejected.append(.init(name: name, reason: .unreadable))
            }
        }
    }

    func discard(_ staged: Staged) {
        if case .file(let url, _) = staged { try? FileManager.default.removeItem(at: url) }
    }

    struct Result {
        let text: String?
        let rejected: [ShareManifest.Rejection]
        let hasContent: Bool
    }

    func finish(caption: String?) -> Result {
        lock.lock(); defer { lock.unlock() }
        var parts = texts
        let hasFiles = !draft.files.isEmpty
        // Some apps put the shared text only in the item's caption.
        if parts.isEmpty, !hasFiles, let caption = caption?.trimmingCharacters(in: .whitespacesAndNewlines), !caption.isEmpty {
            parts = [caption]
        }
        let text = parts.isEmpty ? nil : parts.joined(separator: "\n")
        return Result(text: text, rejected: rejected, hasContent: text != nil || hasFiles || !rejected.isEmpty)
    }
}

/// Waits for one callback. Its work runs under the waiter's lock and is only bookkeeping, so
/// once `wait` gives up a late callback is dropped whole, never half applied.
private final class Waiter {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var closed = false

    /// False when the wait already gave up; `work` then does not run.
    @discardableResult
    func complete(_ work: () -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return false }
        work()
        closed = true
        semaphore.signal()
        return true
    }

    /// True when the callback ran in time.
    func wait(seconds: TimeInterval) -> Bool {
        if semaphore.wait(timeout: .now() + seconds) == .success { return true }
        lock.lock(); defer { lock.unlock() }
        if closed { return true }
        closed = true
        return false
    }
}
