import XCTest

/// Drives the real system share sheet — Photos → share → OpenChamber — and then asserts the
/// app came forward with the file in a new draft. It runs on a simulator, so it needs no
/// signing identity and no developer account; what it exercises is the extension the system
/// registered, the staged inbox and the app side of the hand-off.
final class ShareSheetE2ETests: XCTestCase {
    private let app = XCUIApplication()
    private let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")

    private var serverURL: String {
        ProcessInfo.processInfo.environment["E2E_SERVER_URL"] ?? "http://127.0.0.1:4123"
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        // Photos asks for notification permission on a fresh simulator. Answering it here
        // keeps the default handler (which only taps "Allow") out of the way.
        addUIInterruptionMonitor(withDescription: "Photos notification prompt") { alert in
            for label in ["Don't Allow", "Allow"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    func testSharingAPhotoOpensADraftWithTheFileAttached() throws {
        app.launch()
        connectToServer()

        XCUIDevice.shared.press(.home)
        openTheOnlyPhoto()
        tapShare()
        attachScreenshot(named: "1-share-sheet")

        let entry = shareSheetEntry(named: "OpenChamber")
        XCTAssertTrue(
            entry.waitForExistence(timeout: 30),
            "OpenChamber is not offered by the share sheet:\n\(photos.debugDescription)"
        )
        entry.tap()

        // The extension stages the file in about a second; the pause is for its own alert,
        // which is the only place a refusal says why.
        Thread.sleep(forTimeInterval: 6)
        attachScreenshot(named: "2-extension-running")
        let extensionAlert = photos.alerts.firstMatch
        if extensionAlert.exists {
            let texts = extensionAlert.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " / ")
            print("E2E extension alert: \(extensionAlert.label) — \(texts)")
        }
        // A share extension cannot reliably launch its host app — `extensionContext.open`
        // only works for Today and iMessage extensions — so the file may wait in the inbox
        // until the user comes back. Record which happened, then act like that user.
        let cameForward = app.wait(for: .runningForeground, timeout: 45)
        print("E2E extension brought the app forward: \(cameForward)")
        if !cameForward {
            app.activate()
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 60), "the app did not come back")
        }

        // The staged name comes from the provider, not from us (Photos names its own copies),
        // so the assertion is that an image attachment is on the draft, and the label is
        // reported when it is not.
        let chip = imageAttachment()
        let chipAppeared = chip.waitForExistence(timeout: 90)
        attachScreenshot(named: "3-draft")
        XCTAssertTrue(
            chipAppeared,
            "the new draft has no image attachment:\n\(app.debugDescription)"
        )
        print("E2E attached as: \(chip.label)")
    }

    // MARK: - App side

    private func connectToServer() {
        // A saved connection from an earlier run auto-connects on launch. The connect screen's
        // copy changes between releases, so the screen is recognised by the manual-entry tile
        // rather than by a heading, and the tile is matched loosely because its label also
        // carries the hint under it.
        let manualTile = manualEntryTile()

        guard manualTile.waitForExistence(timeout: 60) || serverURLField().exists else { return }

        // The form starts collapsed because iOS supports QR pairing; opening it is the path a
        // user takes.
        var urlField = serverURLField()
        if !urlField.exists {
            manualTile.tap()
            urlField = serverURLField()
        }
        XCTAssertTrue(urlField.waitForExistence(timeout: 60), "the manual form did not open:\n\(app.debugDescription)")
        let opened = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: urlField)
        XCTAssertEqual(XCTWaiter().wait(for: [opened], timeout: 30), .completed, "the manual form did not open")

        urlField.tap()
        urlField.typeText(serverURL)
        attachScreenshot(named: "0-url-entered")
        submitConnection()

        // The tile going away means the page replaced the connection screen with the app.
        XCTAssertTrue(
            waitUntilGone(manualTile, timeout: 180),
            "the app never left the connection screen:\n\(app.debugDescription)"
        )
    }

    /// The tile carries a hint under its title, so it is matched by the part of the label that
    /// does not change, whichever element type the platform exposes it as.
    private func manualEntryTile() -> XCUIElement {
        let predicate = NSPredicate(format: "label CONTAINS[c] 'Connect by address'")
        let text = app.staticTexts.matching(predicate).firstMatch
        return text.exists ? text : app.buttons.matching(predicate).firstMatch
    }

    /// The label is a stack over the input, so expose either the labelled field or the only
    /// field on the page.
    private func serverURLField() -> XCUIElement {
        let labelled = app.textFields["Server URL"].firstMatch
        return labelled.exists ? labelled : app.textFields.firstMatch
    }

    /// On a 375x667 screen the software keyboard covers the Connect button, and the field sits
    /// in a real form, so Return submits it. Tapping Connect is the fallback once the keyboard
    /// is out of the way.
    private func submitConnection() {
        if app.keyboards.element.exists {
            app.typeText("\n")
        }
        let tile = manualEntryTile()
        if waitUntilGone(tile, timeout: 30) { return }

        let connect = app.buttons["Connect"].firstMatch
        if connect.waitForExistence(timeout: 5), connect.isHittable {
            connect.tap()
        }
    }

    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }

    // MARK: - Photos side

    private func openTheOnlyPhoto() {
        photos.launch()
        XCTAssertTrue(photos.wait(for: .runningForeground, timeout: 60))

        // A fresh simulator covers the library with the "What's New in Photos" sheet and a
        // notification prompt; until both are answered nothing behind them is tappable.
        let whatsNew = photos.buttons["Continue"].firstMatch
        if whatsNew.waitForExistence(timeout: 25) {
            whatsNew.tap()
        }
        photos.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()
        attachScreenshot(named: "photos-library")

        // The grid can open scrolled down behind the toolbar, where no tile is hittable, so
        // swipe to the top and retry until a tap actually opens the viewer.
        for _ in 0..<6 {
            if openAHittablePhoto() { return }
            photos.swipeDown()
            Thread.sleep(forTimeInterval: 1.2)
        }

        attachScreenshot(named: "photos-no-tile")
        XCTFail("could not open a photo: \(photos.debugDescription)")
    }

    /// Taps a photo and reports whether the viewer opened (it is the only screen with Share).
    private func openAHittablePhoto() -> Bool {
        let tiles = photos.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo,'"))
        for index in 0..<min(tiles.count, 12) {
            let tile = tiles.element(boundBy: index)
            guard tile.isHittable else { continue }
            tile.tap()
            if photos.buttons["Share"].waitForExistence(timeout: 4) { return true }
        }
        return false
    }

    private func tapShare() {
        // Exact match: a "CONTAINS share" predicate also catches "Start Sharing" and
        // "Shared Albums" in the library page, which navigate away from the viewer.
        let share = photos.buttons.matching(NSPredicate(
            format: "label == 'Share' OR identifier == 'share'"
        )).firstMatch
        if share.waitForExistence(timeout: 30) {
            share.tap()
            return
        }
        // The photo viewer sometimes exposes the action behind the "more" bar button.
        let more = photos.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'more'")).firstMatch
        XCTAssertTrue(more.exists, "no share control in the photo viewer:\n\(photos.debugDescription)")
        more.tap()
    }

    /// The activity row is a cell on some iOS versions and a button or static text on others,
    /// so this matches the label wherever it is exposed.
    private func shareSheetEntry(named name: String) -> XCUIElement {
        let activities = photos.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", name))
        return activities.element(boundBy: 0)
    }

    // MARK: - Evidence

    /// An attachment on the draft, matched without assuming the exact provider file name.
    private func imageAttachment() -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS[c] '.png' OR label CONTAINS[c] '.jpg' OR label CONTAINS[c] '.jpeg'"
                + " OR label CONTAINS[c] '.heic' OR label CONTAINS[c] '.heif'"
        )).element(boundBy: 0)
    }

    private func attachScreenshot(named name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
