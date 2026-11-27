import Capacitor
import UserNotifications

/// Lists the app's delivered notifications and removes the session banners the web layer saw
/// once the user opened their session (packages/ui/src/lib/nativeNotifications.ts), so they leave
/// without the server's clearing push. The push plugin's own list and removal refuse to run until
/// APNs registration has been attempted in this launch, and the app registers only after the
/// server answers, so with the server unreachable they never would. Removal takes a banner only
/// while it still shows the push the web layer listed: a newer push under the same collapse id
/// keeps the identifier and replaces the content. Registered in BridgeViewController.capacitorDidLoad.
@objc(PushBannersPlugin)
public class PushBannersPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushBannersPlugin"
    public let jsName = "PushBanners"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    @objc func list(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let notifications: [JSObject] = delivered.map { notification in
                let request = notification.request
                return [
                    "id": request.identifier,
                    "data": JSTypes.coerceDictionaryToJSObject(request.content.userInfo) ?? [:],
                ]
            }
            call.resolve(["notifications": notifications])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let banners = call.getArray("banners", JSObject.self) else {
            call.reject("Expected banners")
            return
        }
        var listedPushIds: [String: String] = [:]
        for banner in banners {
            guard let id = banner["id"] as? String, let nid = banner["nid"] as? String else { continue }
            listedPushIds[id] = nid
        }
        guard !listedPushIds.isEmpty else {
            call.resolve()
            return
        }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let identifiers = delivered.compactMap { notification -> String? in
                let request = notification.request
                guard let listed = listedPushIds[request.identifier],
                      request.content.userInfo["nid"] as? String == listed else { return nil }
                return request.identifier
            }
            if !identifiers.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: identifiers)
            }
            call.resolve()
        }
    }
}
