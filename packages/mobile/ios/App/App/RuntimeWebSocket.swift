import Capacitor
import Foundation

@objc(RuntimeWebSocketPlugin)
public class RuntimeWebSocketPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionWebSocketDelegate {
    public let identifier = "RuntimeWebSocketPlugin"
    public let jsName = "RuntimeWebSocket"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    // All socket state and bridge events run on the main queue.
    private var sockets: [String: URLSessionWebSocketTask] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }()

    private func emit(_ id: String, _ type: String, _ data: [String: Any] = [:]) {
        var event = data
        event["id"] = id
        event["type"] = type
        notifyListeners("socketEvent", data: event)
    }

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), self.sockets[id] == nil,
                  let address = call.getString("url"), let url = URL(string: address),
                  ["ws", "wss"].contains(url.scheme ?? ""), url.host != nil,
                  let headers = call.getObject("headers") as? [String: String] else {
                call.reject("Invalid WebSocket request")
                return
            }
            var request = URLRequest(url: url)
            for (name, value) in headers {
                guard name.range(of: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", options: .regularExpression) != nil,
                      !value.contains("\r"), !value.contains("\n") else {
                    call.reject("Invalid WebSocket headers")
                    return
                }
                request.setValue(value, forHTTPHeaderField: name)
            }
            request.setValue("capacitor://localhost", forHTTPHeaderField: "Origin")
            let protocols = call.getArray("protocols", String.self) ?? []
            if !protocols.isEmpty {
                request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
            }
            let task = makeRuntimeWebSocketTask(session: self.session, request: request)
            task.taskDescription = id
            self.sockets[id] = task
            task.resume()
            call.resolve()
        }
    }

    private func receive(_ task: URLSessionWebSocketTask, id: String) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.sockets[id] === task else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text): self.emit(id, "message", ["data": text, "binary": false])
                    case .data(let data): self.emit(id, "message", ["data": data.base64EncodedString(), "binary": true])
                    @unknown default: self.fail(task, id: id); return
                    }
                    self.receive(task, id: id)
                case .failure:
                    if task.closeCode != .invalid {
                        self.finish(task, id: id, code: task.closeCode.rawValue,
                                    reason: task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
                    } else {
                        self.fail(task, id: id)
                    }
                }
            }
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), let task = self.sockets[id],
                  let text = call.getString("data") else {
                call.reject("WebSocket is closed")
                return
            }
            let message: URLSessionWebSocketTask.Message
            if call.getBool("binary") == true {
                guard let data = Data(base64Encoded: text) else { call.reject("Invalid binary frame"); return }
                message = .data(data)
            } else {
                message = .string(text)
            }
            task.send(message) { error in
                if error != nil { call.reject("WebSocket send failed") }
                else { call.resolve() }
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), let task = self.sockets[id] else { call.resolve(); return }
            let code = call.getInt("code") ?? 1000
            let reason = call.getString("reason") ?? ""
            guard let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code),
                  (code == 1000 || (3000...4999).contains(code)), reason.utf8.count <= 123 else {
                call.reject("Invalid close frame")
                return
            }
            task.cancel(with: closeCode, reason: reason.data(using: .utf8))
            self.finish(task, id: id, code: code, reason: reason)
            call.resolve()
        }
    }

    private func finish(_ task: URLSessionWebSocketTask, id: String, code: Int, reason: String) {
        guard sockets[id] === task else { return }
        sockets.removeValue(forKey: id)
        emit(id, "close", ["code": code, "reason": reason])
    }

    private func fail(_ task: URLSessionWebSocketTask, id: String) {
        guard sockets[id] === task else { return }
        emit(id, "error")
        task.cancel()
        finish(task, id: id, code: 1006, reason: "")
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard let id = webSocketTask.taskDescription, sockets[id] === webSocketTask else { return }
        emit(id, "open")
        receive(webSocketTask, id: id)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard let id = webSocketTask.taskDescription else { return }
        finish(webSocketTask, id: id, code: closeCode.rawValue,
               reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error != nil, let socket = task as? URLSessionWebSocketTask, let id = task.taskDescription else { return }
        fail(socket, id: id)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                           completionHandler: @escaping (URLRequest?) -> Void) {
        // Never forward saved proxy credentials through a redirect.
        completionHandler(nil)
    }
}
