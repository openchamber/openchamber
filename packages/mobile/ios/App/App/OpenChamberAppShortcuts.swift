import AppIntents

// App Shortcuts, so "New Session" also shows up in the Shortcuts app and Siri can run it.
// The same OpenNewSessionIntent drives the Control Center / Lock Screen control; it lives in
// OpenChamberControl.swift and is compiled into both this app target and the widget extension.
// Gated to iOS 18.0 to match that intent, so the app's 15.5 deployment target stays clean.
@available(iOS 18.0, *)
struct OpenChamberAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenNewSessionIntent(),
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
