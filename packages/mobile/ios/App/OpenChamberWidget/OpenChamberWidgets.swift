import SwiftUI
import WidgetKit

// MARK: - Medium home-screen widget: recent sessions (left) + quick actions (right)

struct OverviewWidgetView: View {
    let entry: OverviewEntry

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            sessionsColumn
            actionsGrid
        }
    }

    private var sessionsColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            if entry.snapshot.recentSessions.isEmpty {
                Text("No sessions yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                ForEach(entry.snapshot.recentSessions.prefix(4)) { session in
                    Link(destination: WidgetDeepLink.session(session.id)) {
                        HStack(spacing: 8) {
                            // Every row shows a same-size dot so titles align: a filled orange
                            // dot for unread, a hollow grey ring for read.
                            unreadIndicator(session.unread)
                            Text(session.title.isEmpty ? "Untitled" : session.title)
                                .font(.subheadline)
                                .fontWeight(session.unread ? .semibold : .regular)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer(minLength: 0)
                        }
                        // Each row claims an equal share of the height → even distribution, no gap.
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    }
                    .foregroundStyle(.primary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func unreadIndicator(_ unread: Bool) -> some View {
        if unread {
            Circle()
                .fill(Color.orange)
                .frame(width: 7, height: 7)
        } else {
            Circle()
                .strokeBorder(Color.secondary.opacity(0.4), lineWidth: 1.5)
                .frame(width: 7, height: 7)
        }
    }

    private var actionsGrid: some View {
        VStack(spacing: 16) {
            HStack(spacing: 16) {
                actionButton(systemImage: "plus", url: WidgetDeepLink.newSession())
                actionButton(systemImage: "square.stack.3d.up", url: WidgetDeepLink.status())
            }
            HStack(spacing: 16) {
                actionButton(systemImage: "server.rack", url: WidgetDeepLink.instances())
                actionButton(systemImage: "gearshape", url: WidgetDeepLink.settings())
            }
        }
        .frame(maxHeight: .infinity)
    }

    private func actionButton(systemImage: String, url: URL) -> some View {
        Link(destination: url) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .medium))
                .frame(width: 56, height: 56)
                .background(.quaternary, in: Circle())
        }
        .foregroundStyle(.primary)
    }
}

struct OverviewWidget: Widget {
    let kind = "OpenChamberOverview"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OverviewProvider()) { entry in
            OverviewWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("OpenChamber")
        .description("Recent sessions and quick actions.")
        .supportedFamilies([.systemMedium])
    }
}

// MARK: - Small home-screen widget: New Session + quick actions

struct QuickActionsWidgetView: View {
    var body: some View {
        VStack(spacing: 10) {
            // Wide primary button: New Session.
            Link(destination: WidgetDeepLink.newSession()) {
                HStack(spacing: 8) {
                    CubeLogoView()
                        .frame(width: 26, height: 26)
                    Text("Chat")
                        .font(.title3)
                        .fontWeight(.semibold)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.quaternary, in: Capsule())
            }
            .foregroundStyle(.primary)

            // Two round secondary actions.
            HStack(spacing: 10) {
                quickCircle(systemImage: "square.stack.3d.up", url: WidgetDeepLink.status())
                quickCircle(systemImage: "server.rack", url: WidgetDeepLink.instances())
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func quickCircle(systemImage: String, url: URL) -> some View {
        Link(destination: url) {
            Image(systemName: systemImage)
                .font(.system(size: 20, weight: .medium))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.quaternary, in: Circle())
        }
        .foregroundStyle(.primary)
    }
}

struct QuickActionsWidget: Widget {
    let kind = "OpenChamberQuickActions"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OverviewProvider()) { _ in
            QuickActionsWidgetView()
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Quick Actions")
        .description("New session, status and instances.")
        .supportedFamilies([.systemSmall])
    }
}

// MARK: - Large home-screen widget: full session list with project labels

struct SessionsWidgetView: View {
    let entry: OverviewEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if entry.snapshot.recentSessions.isEmpty {
                Text("No sessions yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                VStack(spacing: 0) {
                    ForEach(entry.snapshot.recentSessions.prefix(6)) { session in
                        row(session)
                    }
                }
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            CubeLogoView()
                .frame(width: 20, height: 20)
            Text("Sessions")
                .font(.headline)
            Spacer(minLength: 0)
            if entry.snapshot.attentionCount > 0 {
                Text("\(entry.snapshot.attentionCount)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.orange)
            }
            Link(destination: WidgetDeepLink.newSession()) {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 30, height: 30)
                    .background(.quaternary, in: Circle())
            }
            .foregroundStyle(.primary)
        }
    }

    private func row(_ session: WidgetSession) -> some View {
        Link(destination: WidgetDeepLink.session(session.id)) {
            HStack(spacing: 10) {
                Group {
                    if session.unread {
                        Circle().fill(Color.orange)
                    } else {
                        Circle().strokeBorder(Color.secondary.opacity(0.4), lineWidth: 1.5)
                    }
                }
                .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title.isEmpty ? "Untitled" : session.title)
                        .font(.subheadline)
                        .fontWeight(session.unread ? .semibold : .regular)
                        .lineLimit(1)
                    if let project = session.project, !project.isEmpty {
                        Text(project)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 7)
        }
        .foregroundStyle(.primary)
    }
}

struct SessionsWidget: Widget {
    let kind = "OpenChamberSessions"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OverviewProvider()) { entry in
            SessionsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Sessions")
        .description("Recent sessions with their project.")
        .supportedFamilies([.systemLarge])
    }
}

// MARK: - Lock Screen: logo → new session

struct LockNewSessionView: View {
    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            CubeLogoView()
                .padding(7)
        }
        .widgetURL(WidgetDeepLink.newSession())
    }
}

struct LockNewSessionWidget: Widget {
    let kind = "OpenChamberLockNew"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OverviewProvider()) { _ in
            LockNewSessionView()
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("New Session")
        .description("Start a new OpenChamber session.")
        .supportedFamilies([.accessoryCircular])
    }
}

// MARK: - Lock Screen: attention counter

struct LockAttentionView: View {
    let entry: OverviewEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Text("\(entry.snapshot.attentionCount)")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                Image(systemName: "bell.badge")
                    .font(.system(size: 10))
            }
        }
        .widgetURL(WidgetDeepLink.attention())
    }
}

struct LockAttentionWidget: Widget {
    let kind = "OpenChamberLockAttention"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OverviewProvider()) { entry in
            LockAttentionView(entry: entry)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("Needs Attention")
        .description("How many sessions need attention.")
        .supportedFamilies([.accessoryCircular])
    }
}

// MARK: - Bundle

@main
struct OpenChamberWidgetBundle: WidgetBundle {
    var body: some Widget {
        OverviewWidget()
        SessionsWidget()
        QuickActionsWidget()
        LockNewSessionWidget()
        LockAttentionWidget()
        if #available(iOS 18.0, *) {
            OpenChamberNewSessionControl()
        }
    }
}
