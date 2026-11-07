import XCTest

/// Runs in the simulator against the real `FileManager`: what is asserted here is the file
/// moving and the manifest being read back, not a mock of either.
final class ShareInboxTests: XCTestCase {
    private let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

    private var container: URL!

    override func setUpWithError() throws {
        container = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShareInboxTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: container)
    }

    private func stageFile(named name: String, bytes: Data) throws -> String {
        let id = UUID().uuidString
        try bytes.write(to: ShareInbox.inbox(in: container).appendingPathComponent(id))
        return id
    }

    /// A file of the given size without writing its bytes: the batch test only needs the
    /// size, and 23 MB of zeros twice would slow the suite down for nothing.
    private func sparseFile(size: Int) throws -> String {
        let id = UUID().uuidString
        let url = ShareInbox.inbox(in: container).appendingPathComponent(id)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(size))
        try handle.close()
        return id
    }

    private func writeManifest(_ records: [ShareInbox.Record], text: String? = nil) throws {
        try ShareInbox.write(records, text: text, in: ShareInbox.inbox(in: container))
    }

    func testResetReplacesThePreviousShare() throws {
        let first = try ShareInbox.resetDirectory(in: container)
        try "stale".write(to: first.appendingPathComponent("stale.json"), atomically: true, encoding: .utf8)

        let second = try ShareInbox.resetDirectory(in: container)

        XCTAssertEqual(second, first)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: second.path).sorted(),
            [],
            "the newest share must not arrive with files of the previous one"
        )
    }

    func testTakeReturnsTheStagedBytesAndEmptiesTheInbox() throws {
        _ = try ShareInbox.resetDirectory(in: container)
        let id = try stageFile(named: "photo.png", bytes: pngBytes)
        try writeManifest([
            ShareInbox.Record(id: id, name: "photo.png", mimeType: "image/png", size: pngBytes.count, rejected: nil),
            ShareInbox.Record(id: "", name: "ninth.png", mimeType: "image/png", size: 0, rejected: "too-many"),
        ])

        let taken = ShareInbox.take(in: container)

        XCTAssertEqual(taken.files.count, 1)
        XCTAssertEqual(taken.files.first?["name"] as? String, "photo.png")
        XCTAssertEqual(taken.files.first?["mimeType"] as? String, "image/png")
        let base64 = try XCTUnwrap(taken.files.first?["data"] as? String)
        XCTAssertEqual(Data(base64Encoded: base64), pngBytes)
        XCTAssertEqual(taken.rejected, [["name": "ninth.png", "reason": "too-many"]])

        XCTAssertEqual(ShareInbox.take(in: container).files.count, 0, "a share is delivered once")
        XCTAssertFalse(ShareInbox.hasPending())
    }

    func testTakeDeliversOnceWhenTwoCallersRace() throws {
        _ = try ShareInbox.resetDirectory(in: container)
        let id = try stageFile(named: "photo.png", bytes: pngBytes)
        try writeManifest([
            ShareInbox.Record(id: id, name: "photo.png", mimeType: "image/png", size: pngBytes.count, rejected: nil),
        ])

        let first = ShareInbox.take(in: container)
        let second = ShareInbox.take(in: container)

        XCTAssertEqual(first.files.count, 1)
        XCTAssertEqual(second.files.count, 0)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: container.path)
            .filter { $0.hasPrefix(ShareInbox.directoryName) }
        XCTAssertEqual(leftovers, [], "a claimed inbox must not be left behind")
    }

    func testTakeRefusesAFileOverTheSingleFileLimit() throws {
        _ = try ShareInbox.resetDirectory(in: container)
        let id = try stageFile(named: "big.bin", bytes: Data(repeating: 0, count: 4))
        try writeManifest([
            ShareInbox.Record(
                id: id, name: "big.bin", mimeType: "application/octet-stream",
                size: ShareInbox.maxFileBytes + 1, rejected: nil
            ),
        ])

        let taken = ShareInbox.take(in: container)

        XCTAssertEqual(taken.files.count, 0)
        XCTAssertEqual(taken.rejected, [["name": "big.bin", "reason": "too-large"]])
    }

    func testTakeStopsAtTheBatchLimitAndNamesTheRest() throws {
        _ = try ShareInbox.resetDirectory(in: container)
        let perFile = ShareInbox.maxFileBytes - 1024
        let firstID = try sparseFile(size: perFile)
        let secondID = try sparseFile(size: perFile)
        try writeManifest([
            ShareInbox.Record(id: firstID, name: "first.bin", mimeType: "application/octet-stream", size: perFile, rejected: nil),
            ShareInbox.Record(id: secondID, name: "second.bin", mimeType: "application/octet-stream", size: perFile, rejected: nil),
        ])

        let taken = ShareInbox.take(in: container)

        XCTAssertEqual(taken.files.count, 1)
        XCTAssertEqual(taken.rejected, [["name": "second.bin", "reason": "batch-limit"]])
    }

    func testTakeReportsAFileThatIsGoneInsteadOfDroppingIt() throws {
        _ = try ShareInbox.resetDirectory(in: container)
        try writeManifest([
            ShareInbox.Record(id: "missing", name: "gone.png", mimeType: "image/png", size: 8, rejected: nil),
        ])

        let taken = ShareInbox.take(in: container)

        XCTAssertEqual(taken.files.count, 0)
        XCTAssertEqual(taken.rejected, [["name": "gone.png", "reason": "unreadable"]])
    }

    func testAnUnreadableManifestEmptiesTheInboxQuietly() throws {
        let inbox = try ShareInbox.resetDirectory(in: container)
        try Data("not json".utf8).write(to: inbox.appendingPathComponent(ShareInbox.manifestName))

        let taken = ShareInbox.take(in: container)

        XCTAssertEqual(taken.files.count, 0)
        XCTAssertEqual(taken.rejected.count, 0)
        XCTAssertNil(taken.text)
        XCTAssertFalse(FileManager.default.fileExists(atPath: inbox.path))
    }

    func testTakeReturnsSharedTextTogetherWithTheFiles() throws {
        _ = try ShareInbox.resetDirectory(in: container)
        let id = try stageFile(named: "photo.png", bytes: pngBytes)
        try writeManifest(
            [ShareInbox.Record(id: id, name: "photo.png", mimeType: "image/png", size: pngBytes.count, rejected: nil)],
            text: "Screenshot of the failing test"
        )

        let taken = ShareInbox.take(in: container)

        XCTAssertEqual(taken.files.count, 1)
        XCTAssertEqual(taken.text, "Screenshot of the failing test")
        XCTAssertNil(ShareInbox.take(in: container).text, "text is delivered once, like the files")
    }

    func testTextOnlyShareIsDelivered() throws {
        let inbox = try ShareInbox.resetDirectory(in: container)
        XCTAssertFalse(ShareInbox.hasPending(in: container), "a reset inbox holds nothing until a share is written")
        try writeManifest([], text: "https://openchamber.dev/session/abc")
        XCTAssertTrue(ShareInbox.hasPending(in: container))

        let taken = ShareInbox.take(in: container)

        XCTAssertEqual(taken.files.count, 0)
        XCTAssertEqual(taken.rejected.count, 0)
        XCTAssertEqual(taken.text, "https://openchamber.dev/session/abc")
        XCTAssertFalse(FileManager.default.fileExists(atPath: inbox.path))
    }
}
