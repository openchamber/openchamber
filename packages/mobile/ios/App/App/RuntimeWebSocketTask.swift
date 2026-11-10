import Foundation

func makeRuntimeWebSocketTask(session: URLSession, request: URLRequest) -> URLSessionWebSocketTask {
    let task = session.webSocketTask(with: request)
    // Terminal snapshots contain up to 512 KiB of history. JSON control-character
    // escaping can expand it sixfold; leave room for the snapshot metadata.
    task.maximumMessageSize = 4 * 1024 * 1024
    return task
}
