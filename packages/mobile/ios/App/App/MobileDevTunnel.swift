import Capacitor
import Foundation
import Network

/// A loopback-only TCP listener for each preview. The trusted Capacitor renderer
/// carries opaque bytes through /api/dev-tunnel, including over the E2EE relay.
@objc(MobileDevTunnelPlugin)
public class MobileDevTunnelPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileDevTunnelPlugin"
    public let jsName = "MobileDevTunnel"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private final class Channel {
        let id = UUID().uuidString
        let tunnelId: String
        let connection: NWConnection
        var reading = false
        var readCredit = false
        var closed = false
        var started = false

        init(tunnelId: String, connection: NWConnection) {
            self.tunnelId = tunnelId
            self.connection = connection
        }
    }

    // All listener and socket state belongs to one serial queue.
    private let queue = DispatchQueue(label: "com.openchamber.mobile-dev-tunnel", qos: .userInitiated)
    private var listeners: [String: NWListener] = [:]
    private var connections: [String: Channel] = [:]
    private let maxConnections = 64

    private func key(_ id: String, _ connectionId: String) -> String {
        return "\(id)|\(connectionId)"
    }

    private func emit(_ channel: Channel, _ type: String, _ data: [String: Any] = [:]) {
        var event = data
        event["id"] = channel.tunnelId
        event["connectionId"] = channel.id
        event["type"] = type
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("tunnelEvent", data: event)
        }
    }

    private func closeChannel(_ channel: Channel) {
        guard !channel.closed else { return }
        channel.closed = true
        connections.removeValue(forKey: key(channel.tunnelId, channel.id))
        channel.connection.cancel()
        emit(channel, "close")
    }

    private func readIfReady(_ channel: Channel) {
        guard !channel.closed && !channel.reading && channel.readCredit else { return }
        channel.readCredit = false
        channel.reading = true
        channel.connection.receive(minimumIncompleteLength: 1, maximumLength: 32 * 1024) { [weak self, weak channel] data, _, complete, error in
            guard let self, let channel else { return }
            self.queue.async {
                guard !channel.closed else { return }
                channel.reading = false
                if let data, !data.isEmpty {
                    self.emit(channel, "data", ["data": data.base64EncodedString()])
                } else {
                    // No bytes were delivered; reading again does not require a JS ack.
                    channel.readCredit = true
                }
                if complete || error != nil {
                    self.closeChannel(channel)
                } else {
                    self.readIfReady(channel)
                }
            }
        }
    }

    private func accept(_ connection: NWConnection, tunnelId: String) {
        guard listeners[tunnelId] != nil && connections.count < maxConnections else {
            connection.cancel()
            return
        }
        let channel = Channel(tunnelId: tunnelId, connection: connection)
        connections[key(tunnelId, channel.id)] = channel
        queue.asyncAfter(deadline: .now() + 10) { [weak self, weak channel] in
            guard let self, let channel, !channel.started else { return }
            self.closeChannel(channel)
        }
        connection.stateUpdateHandler = { [weak self, weak channel] state in
            guard let self, let channel else { return }
            switch state {
            case .ready:
                self.emit(channel, "connect")
            case .failed, .cancelled:
                self.closeChannel(channel)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    @objc public func start(_ call: CAPPluginCall) {
        queue.async {
            guard let id = call.getString("id"), self.listeners[id] == nil else {
                call.reject("Invalid dev tunnel")
                return
            }
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                let listener = try NWListener(using: parameters)
                self.listeners[id] = listener
                listener.newConnectionHandler = { [weak self] connection in
                    self?.accept(connection, tunnelId: id)
                }
                listener.stateUpdateHandler = { [weak self] state in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        guard let port = listener.port?.rawValue else {
                            call.reject("Cannot listen for dev-server preview")
                            return
                        }
                        call.resolve(["localPort": Int(port)])
                    case .failed:
                        self.listeners.removeValue(forKey: id)
                        listener.newConnectionHandler = nil
                        listener.stateUpdateHandler = nil
                        listener.cancel()
                        for channel in Array(self.connections.values) where channel.tunnelId == id {
                            self.closeChannel(channel)
                        }
                        call.reject("Cannot listen for dev-server preview")
                    default:
                        break
                    }
                }
                listener.start(queue: self.queue)
            } catch {
                call.reject("Cannot listen for dev-server preview")
            }
        }
    }

    @objc public func ready(_ call: CAPPluginCall) {
        grantRead(call)
    }

    @objc public func ack(_ call: CAPPluginCall) {
        grantRead(call)
    }

    private func grantRead(_ call: CAPPluginCall) {
        queue.async {
            if let id = call.getString("id"), let connectionId = call.getString("connectionId"),
               let channel = self.connections[self.key(id, connectionId)], !channel.closed {
                channel.started = true
                channel.readCredit = true
                self.readIfReady(channel)
            }
            call.resolve()
        }
    }

    @objc public func send(_ call: CAPPluginCall) {
        queue.async {
            guard let id = call.getString("id"), let connectionId = call.getString("connectionId"),
                  let channel = self.connections[self.key(id, connectionId)], !channel.closed,
                  let base64 = call.getString("data"), let bytes = Data(base64Encoded: base64) else {
                call.reject("Dev tunnel closed")
                return
            }
            channel.connection.send(content: bytes, completion: .contentProcessed { error in
                if error != nil {
                    self.queue.async { self.closeChannel(channel) }
                    call.reject("Dev tunnel closed")
                } else {
                    call.resolve()
                }
            })
        }
    }

    @objc public func close(_ call: CAPPluginCall) {
        queue.async {
            if let id = call.getString("id"), let connectionId = call.getString("connectionId"),
               let channel = self.connections[self.key(id, connectionId)] {
                self.closeChannel(channel)
            }
            call.resolve()
        }
    }

    @objc public func stop(_ call: CAPPluginCall) {
        queue.async {
            if let id = call.getString("id") {
                if let listener = self.listeners.removeValue(forKey: id) {
                    listener.newConnectionHandler = nil
                    listener.stateUpdateHandler = nil
                    listener.cancel()
                }
                for channel in Array(self.connections.values) where channel.tunnelId == id {
                    self.closeChannel(channel)
                }
            }
            call.resolve()
        }
    }

    deinit {
        for listener in listeners.values {
            listener.newConnectionHandler = nil
            listener.stateUpdateHandler = nil
            listener.cancel()
        }
        for channel in connections.values { channel.connection.cancel() }
    }
}
