import XCTest
import UniformTypeIdentifiers

/// Drives the real `NSItemProvider` file hand-off in the simulator: the point is that the
/// copy happens inside the load callback, which is the step that silently loses the file
/// when it moves one line too late.
final class ShareStagingTests: XCTestCase {
    private let pngBytes = Data([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    ])

    private var container: URL!
    private var inbox: URL!

    override func setUpWithError() throws {
        container = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShareStagingTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        inbox = try ShareInbox.resetDirectory(in: container)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: container)
    }

    /// A file outside the inbox, the way the share sheet hands one over.
    private func sourceFile(named name: String, bytes: Data) throws -> URL {
        let url = container.appendingPathComponent("source-\(UUID().uuidString)-\(name)")
        try bytes.write(to: url)
        return url
    }

    private func sparseSourceFile(named name: String, size: Int) throws -> URL {
        let url = container.appendingPathComponent("source-\(UUID().uuidString)-\(name)")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(size))
        try handle.close()
        return url
    }

    private func providers(_ urls: [URL], name: String = "photo.png") -> [NSItemProvider] {
        urls.compactMap { url in
            let provider = NSItemProvider(contentsOf: url)
            provider?.suggestedName = name
            return provider
        }
    }

    func testStagesACopyOfTheSharedFile() async throws {
        let source = try sourceFile(named: "photo.png", bytes: pngBytes)
        let provider = try XCTUnwrap(providers([source]).first)

        let records = await ShareStaging.records(from: [provider], in: inbox)

        let record = try XCTUnwrap(records.first)
        XCTAssertNil(record.rejected)
        XCTAssertEqual(record.mimeType, "image/png")
        XCTAssertEqual(record.size, pngBytes.count)
        XCTAssertEqual(record.name, "photo.png", "the provider names its temporary copy after the shared file")
        XCTAssertFalse(record.id.isEmpty)
        let staged = try Data(contentsOf: inbox.appendingPathComponent(record.id))
        XCTAssertEqual(staged, pngBytes, "the copy must survive the temporary file being deleted")
    }

    func testRefusesAFileOverTheLimitWithoutCopyingIt() async throws {
        let source = try sparseSourceFile(named: "big.bin", size: ShareInbox.maxFileBytes + 1)
        let provider = try XCTUnwrap(providers([source]).first)

        let records = await ShareStaging.records(from: [provider], in: inbox)

        let record = try XCTUnwrap(records.first)
        XCTAssertEqual(record.rejected, "too-large")
        XCTAssertEqual(record.size, ShareInbox.maxFileBytes + 1)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: inbox.path), [])
    }

    func testReportsAProviderWithNoDataRepresentation() async throws {
        let provider = NSItemProvider()
        provider.suggestedName = "notes.txt"

        let records = await ShareStaging.records(from: [provider], in: inbox)

        let record = try XCTUnwrap(records.first)
        XCTAssertEqual(record.rejected, "unsupported-type")
        XCTAssertEqual(record.name, "notes.txt")
    }

    func testReportsAFileTheProviderCannotOpen() async throws {
        let source = try sourceFile(named: "photo.png", bytes: pngBytes)
        let provider = try XCTUnwrap(providers([source]).first)
        try FileManager.default.removeItem(at: source)

        let records = await ShareStaging.records(from: [provider], in: inbox)

        let record = try XCTUnwrap(records.first)
        XCTAssertEqual(record.rejected, "unreadable")
    }

    func testCapsTheShareAtEightFilesAndNamesTheRest() async throws {
        let urls = try (0..<10).map { index in
            try sourceFile(named: "photo-\(index).png", bytes: pngBytes)
        }

        let records = await ShareStaging.records(from: providers(urls), in: inbox)

        XCTAssertEqual(records.count, 10)
        XCTAssertEqual(records.prefix(8).filter { $0.rejected == nil }.count, 8)
        XCTAssertEqual(records.suffix(2).map(\.rejected), ["too-many", "too-many"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: inbox.path).count, 8)
    }

    func testEmptyShareStagesNothing() async throws {
        let records = await ShareStaging.records(from: [], in: inbox)
        XCTAssertEqual(records.count, 0)
    }

    // MARK: - Text and links

    private func textProvider(_ text: String) -> NSItemProvider {
        NSItemProvider(item: NSString(string: text), typeIdentifier: UTType.plainText.identifier)
    }

    private func linkProvider(_ link: String) -> NSItemProvider {
        NSItemProvider(item: NSURL(string: link)!, typeIdentifier: UTType.url.identifier)
    }

    func testATextShareBecomesComposerTextNotARejectedFile() async throws {
        let providers = [textProvider("Summarise this thread")]

        let records = await ShareStaging.records(from: providers, in: inbox)
        let text = await ShareStaging.text(from: providers)

        XCTAssertEqual(records.count, 0, "text is not an attachment, so it must not be reported as unsupported")
        XCTAssertEqual(text, "Summarise this thread")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: inbox.path), [])
    }

    func testASharedLinkArrivesAsItsURL() async throws {
        let providers = [linkProvider("https://openchamber.dev/session/abc?")]

        let text = await ShareStaging.text(from: providers)
        let records = await ShareStaging.records(from: providers, in: inbox)

        XCTAssertEqual(text, "https://openchamber.dev/session/abc?")
        XCTAssertEqual(records.count, 0)
    }

    func testTheLinkWinsOverTheCopySafariAlsoSends() async throws {
        // Safari offers the URL and its plain-text form; the composer should get one line.
        let providers = [textProvider("https://example.com/article"), linkProvider("https://example.com/article")]

        let text = await ShareStaging.text(from: providers)

        XCTAssertEqual(text, "https://example.com/article")
    }

    func testTextAndAFileBothSurvive() async throws {
        let source = try sourceFile(named: "shot.png", bytes: pngBytes)
        let fileProvider = try XCTUnwrap(providers([source]).first)
        let providers = [textProvider("Screenshot of the failing test"), fileProvider]

        let records = await ShareStaging.records(from: providers, in: inbox)
        let text = await ShareStaging.text(from: providers)

        XCTAssertEqual(records.count, 1)
        XCTAssertNil(records.first?.rejected)
        XCTAssertEqual(text, "Screenshot of the failing test")
    }

    func testBlankTextIsNotDelivered() async throws {
        let text = await ShareStaging.text(from: [textProvider("   \n")])
        XCTAssertNil(text)
    }
}
