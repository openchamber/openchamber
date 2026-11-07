import Foundation
import UniformTypeIdentifiers

/// Copies what the share sheet handed over into the inbox. It lives apart from the view
/// controller so the copy, the naming and the per-share limits can be tested without an
/// extension context.
enum ShareStaging {
    static let maxFiles = 8

    static func records(from context: NSExtensionContext?, in directory: URL) async -> [ShareInbox.Record] {
        await records(from: providers(in: context), in: directory)
    }

    /// The share sheet sends one item per app, and each item carries its own attachments.
    static func providers(in context: NSExtensionContext?) -> [NSItemProvider] {
        (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    }

    static func records(from providers: [NSItemProvider], in directory: URL) async -> [ShareInbox.Record] {
        guard !providers.isEmpty else { return [] }

        var records: [ShareInbox.Record] = []
        for provider in providers.prefix(maxFiles) {
            records.append(await record(from: provider, in: directory))
        }
        for provider in providers.dropFirst(maxFiles) {
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
