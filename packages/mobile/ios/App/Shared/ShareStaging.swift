import Foundation
import UniformTypeIdentifiers

/// Copies what the share sheet handed over into the inbox. It lives apart from the view
/// controller so the copy, the naming and the per-share limits can be tested without an
/// extension context.
enum ShareStaging {
    static let maxFiles = 8

    /// The share sheet sends one item per app, and each item carries its own attachments.
    static func providers(in context: NSExtensionContext?) -> [NSItemProvider] {
        (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    }

    /// True when the provider carries text or a link and nothing that can be attached. A share
    /// of a link from Safari offers both `public.url` and `public.plain-text`, and a share of a
    /// plain `.txt` file looks like text too — both become composer text, which is what the
    /// user meant by selecting them.
    static func isTextOnly(_ provider: NSItemProvider) -> Bool {
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        guard types.contains(where: { $0.conforms(to: .text) || $0.conforms(to: .url) }) else {
            return false
        }
        return !types.contains { type in
            type.conforms(to: .image) || type.conforms(to: .movie) || type.conforms(to: .audio)
                || (type.conforms(to: .data) && !type.conforms(to: .text) && !type.conforms(to: .url))
        }
    }

    /// The link or paragraph a share carried, if any. A provider that offers both is read as
    /// its link, so a shared article arrives as one URL instead of URL plus its title.
    static func text(from providers: [NSItemProvider]) async -> String? {
        let candidates = providers.filter(isTextOnly)
        guard !candidates.isEmpty else { return nil }

        var paragraph: String?
        for provider in candidates {
            if let url = await link(from: provider), !url.isEmpty {
                return url
            }
            if paragraph == nil, let value = await plainText(from: provider),
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                paragraph = value
            }
        }
        return paragraph
    }

    private static func link(from provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                let value: String?
                switch item {
                case let url as URL: value = url.absoluteString
                case let text as String: value = text
                default: value = nil
                }
                continuation.resume(returning: value)
            }
        }
    }

    private static func plainText(from provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                let value: String?
                switch item {
                case let text as String: value = text
                case let attributed as NSAttributedString: value = attributed.string
                case let data as Data: value = String(data: data, encoding: .utf8)
                default: value = nil
                }
                continuation.resume(returning: value)
            }
        }
    }

    static func records(from providers: [NSItemProvider], in directory: URL) async -> [ShareInbox.Record] {
        // Text and links are the page's business, not attachments.
        let fileProviders = providers.filter { !isTextOnly($0) }
        guard !fileProviders.isEmpty else { return [] }

        var records: [ShareInbox.Record] = []
        for provider in fileProviders.prefix(maxFiles) {
            records.append(await record(from: provider, in: directory))
        }
        for provider in fileProviders.dropFirst(maxFiles) {
            records.append(ShareInbox.Record(
                id: "",
                name: provider.suggestedName ?? "file",
                mimeType: "application/octet-stream",
                size: 0,
                rejected: "too-many"
            ))
        }
        return records
    }

    static func record(from provider: NSItemProvider, in directory: URL) async -> ShareInbox.Record {
        // Read before the callback: capturing the provider inside it is a Sendable warning,
        // and the name never changes.
        let fallbackName = provider.suggestedName ?? "file"
        guard let type = fileType(of: provider) else {
            return ShareInbox.Record(
                id: "",
                name: fallbackName,
                mimeType: "application/octet-stream",
                size: 0,
                rejected: "unsupported-type"
            )
        }
        let mimeType = type.preferredMIMEType ?? "application/octet-stream"

        return await withCheckedContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                // `url` is a temporary file the system deletes after this callback returns,
                // so the copy has to happen here, not after the continuation resumes.
                guard let url else {
                    continuation.resume(returning: ShareInbox.Record(
                        id: "", name: fallbackName, mimeType: mimeType, size: 0, rejected: "unreadable"
                    ))
                    return
                }

                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                let name = url.lastPathComponent.isEmpty ? fallbackName : url.lastPathComponent
                guard size > 0 else {
                    continuation.resume(returning: ShareInbox.Record(
                        id: "", name: name, mimeType: mimeType, size: 0, rejected: "unreadable"
                    ))
                    return
                }
                guard size <= ShareInbox.maxFileBytes else {
                    continuation.resume(returning: ShareInbox.Record(
                        id: "", name: name, mimeType: mimeType, size: size, rejected: "too-large"
                    ))
                    return
                }

                let id = UUID().uuidString
                do {
                    try FileManager.default.copyItem(at: url, to: directory.appendingPathComponent(id))
                } catch {
                    continuation.resume(returning: ShareInbox.Record(
                        id: "", name: name, mimeType: mimeType, size: size, rejected: "unreadable"
                    ))
                    return
                }
                continuation.resume(returning: ShareInbox.Record(
                    id: id, name: name, mimeType: mimeType, size: size, rejected: nil
                ))
            }
        }
    }

    /// A declared identifier with a MIME type first: `public.data` alone would lose the
    /// extension on the way to the composer.
    static func fileType(of provider: NSItemProvider) -> UTType? {
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        return types.first { $0.conforms(to: .data) && $0.preferredMIMEType != nil }
            ?? types.first { $0.conforms(to: .data) }
    }
}
