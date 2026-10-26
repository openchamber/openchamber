import AppIntents

// App Shortcuts, so "New Session" also shows up in the Shortcuts app and Siri can run it.
//
// The Control Center control's OpenNewSessionIntent (OpenChamberControl.swift) answers with an
// OpenURLIntent for `openchamber://new`. The system honours that from a control, but Shortcuts
// and Siri refuse to open a custom URL scheme ("launch is prohibited"). This intent lives only
// in the app target: it runs inside the launched app and hands its request to the page through
// the ShortcutRequests plugin (ShortcutRequests.swift).
// Gated to iOS 18.0 to match the control, so the app's 15.5 deployment target stays clean.
@available(iOS 18.0, *)
struct NewSessionShortcutIntent: AppIntent {
    static let title: LocalizedStringResource = "New OpenChamber Session"
    static let description = IntentDescription(
        "Opens OpenChamber on a new session. With a message, starts the session in the project and sends the message."
    )
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Project", description: "Where the session starts. Without one, it opens where you last worked.")
    var project: ShortcutProjectEntity?

    @Parameter(title: "Message", description: "Sent as the first message.", inputOptions: String.IntentInputOptions(multiline: true))
    var message: String?

    static var parameterSummary: some ParameterSummary {
        Summary("New session in \(\.$project)") {
            \.$message
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        ShortcutRequestInbox.deliver(projectId: project?.id, text: message)
        return .result()
    }
}

@available(iOS 18.0, *)
struct OpenChamberAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NewSessionShortcutIntent(),
            phrases: [
                "Start a new session in \(.applicationName)",
                "Start a new \(.applicationName) session",
                "New session in \(.applicationName)",
            ],
            shortTitle: "New Session",
            systemImageName: "plus.bubble"
        )
    }
}
