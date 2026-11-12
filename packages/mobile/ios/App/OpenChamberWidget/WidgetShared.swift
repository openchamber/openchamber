import SwiftUI
import WidgetKit

// MARK: - Shared model + App Group reader

/// One row of the session overview the app writes to the shared App Group.
/// Mirrors MobileWidgetSession in packages/ui/src/apps/mobileWidgetSnapshot.ts.
struct WidgetSession: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let unread: Bool
    /// Project label for the session's directory. Optional so snapshots written before this
    /// field existed still decode.
    var project: String?
}

/// The session overview snapshot. Mirrors MobileWidgetSnapshot (same field names) so the
/// JSON the app stores decodes directly.
struct WidgetSnapshot: Codable {
    var runtimeKey: String?
    let attentionCount: Int
    let recentSessions: [WidgetSession]

    static let empty = WidgetSnapshot(runtimeKey: nil, attentionCount: 0, recentSessions: [])
}

enum WidgetStore {
    static let appGroup = "group.com.openchamber.app"
    static let snapshotKey = "widgetSnapshot"

    /// Reads the latest snapshot the app persisted. Returns `.empty` when nothing has been
    /// written yet (fresh install / app never foregrounded) so widgets render a clean state.
    static func load() -> WidgetSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup),
              let json = defaults.string(forKey: snapshotKey),
              let data = json.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else {
            return .empty
        }
        return snapshot
    }
}

// MARK: - Deep links (mirror packages/ui/src/apps/deepLinks.ts)

enum WidgetDeepLink {
    static func newSession() -> URL { URL(string: "openchamber://new")! }
    static func attention() -> URL { URL(string: "openchamber://sessions?filter=attention")! }
    static func status() -> URL { URL(string: "openchamber://status")! }
    static func settings() -> URL { URL(string: "openchamber://settings")! }
    static func changes() -> URL { URL(string: "openchamber://changes")! }
    static func files() -> URL { URL(string: "openchamber://view/files")! }
    static func instances() -> URL { URL(string: "openchamber://view/instances")! }
    static func session(_ id: String) -> URL {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return URL(string: "openchamber://session/\(encoded)") ?? newSession()
    }
}

// MARK: - Timeline provider

struct OverviewEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct OverviewProvider: TimelineProvider {
    func placeholder(in context: Context) -> OverviewEntry {
        OverviewEntry(date: Date(), snapshot: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (OverviewEntry) -> Void) {
        completion(OverviewEntry(date: Date(), snapshot: WidgetStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<OverviewEntry>) -> Void) {
        // The app/NSE reload timelines (WidgetCenter) when the snapshot changes, but with several
        // widgets sharing the app's WidgetKit reload budget iOS can refresh them unevenly and
        // leave one stale. Ask for a periodic refresh too so every widget independently re-reads
        // the shared snapshot and converges to the latest state (budget permitting).
        let entry = OverviewEntry(date: Date(), snapshot: WidgetStore.load())
        let nextRefresh = Date().addingTimeInterval(10 * 60)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

// MARK: - Logo (full OpenChamber mark drawn from the SVG)

/// The OpenChamber logo, drawn to match packages/web/public/logo-dark-512x512.svg (generated
/// by scripts/brand): the open-shell cube with lightly shaded back walls, a faint roof and three
/// roof tiers that brighten towards the centre. Everything uses `.primary` at some opacity, so
/// the system tint on the Lock Screen / Control Center keeps the layers apart. Coordinates are
/// the SVG's (range x:-41.568…41.568, y:-48…48); the roof is centred on (0, -24).
/// Hand-kept copy of the in-app logo in scripts/brand/geometry.mjs: brand:generate does not
/// write it, so update it whenever that drawing changes.
struct CubeLogoView: View {
    var body: some View {
        Canvas { context, size in
            let halfW: CGFloat = 41.568
            let halfH: CGFloat = 48
            let scale = min(size.width / (halfW * 2), size.height / (halfH * 2))
            let cx = size.width / 2
            let cy = size.height / 2
            let lineWidth = max(1.2, 2.2 * scale)

            // Cube coordinate → canvas point.
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: cx + x * scale, y: cy + y * scale) }
            func polygon(_ points: [(CGFloat, CGFloat)]) -> Path {
                var path = Path()
                path.move(to: p(points[0].0, points[0].1))
                for point in points.dropFirst() { path.addLine(to: p(point.0, point.1)) }
                path.closeSubpath()
                return path
            }
            // Roof rhombus, or a tier inside it, at `s` of the roof.
            func rhombus(_ s: CGFloat) -> Path {
                polygon([(0, -24 - 24 * s), (halfW * s, -24), (0, -24 + 24 * s), (-halfW * s, -24)])
            }

            // The back walls seen through the open front.
            context.fill(polygon([(-halfW, -24), (-halfW, 24), (0, 0)]), with: .color(.primary.opacity(0.12)))
            context.fill(polygon([(halfW, -24), (0, 0), (halfW, 24)]), with: .color(.primary.opacity(0.15)))
            context.fill(rhombus(1), with: .color(.primary.opacity(0.08)))
            for (s, opacity) in [(0.8, 0.22), (0.58, 0.27), (0.36, 0.85)] as [(CGFloat, Double)] {
                context.fill(rhombus(s), with: .color(.primary.opacity(opacity)))
            }

            var edges = rhombus(1)
            edges.move(to: p(-halfW, -24)); edges.addLine(to: p(-halfW, 24)); edges.addLine(to: p(0, 48))
            edges.addLine(to: p(halfW, 24)); edges.addLine(to: p(halfW, -24))
            edges.move(to: p(0, 0)); edges.addLine(to: p(0, 48))
            context.stroke(edges, with: .color(.primary), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
        }
    }
}
