import CoreGraphics
import Foundation

final class FrameRelay: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    enum Link: String {
        case idle
        case connecting
        case open
        case waiting
    }

    var onLink: (@Sendable (Link) -> Void)?
    var onError: (@Sendable (String) -> Void)?

    private let lock = NSLock()
    private let encodeQueue = DispatchQueue(label: "glassesrelay.encode", qos: .userInitiated)
    private let minInterval = 0.05
    private let stallLimit = 5.0
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var url: URL?
    private var running = false
    private var open = false
    private var busy = false
    private var attempt = 0
    private var lastAccepted: TimeInterval = 0
    private var sent = 0

    func start(url: URL) {
        stop()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 6
        configuration.waitsForConnectivity = false
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        lock.lock()
        self.url = url
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        running = true
        attempt = 0
        sent = 0
        lock.unlock()
        connect()
    }

    func stop() {
        lock.lock()
        let oldSession = session
        let oldTask = task
        running = false
        open = false
        busy = false
        session = nil
        task = nil
        lock.unlock()
        oldTask?.cancel(with: .normalClosure, reason: nil)
        oldSession?.invalidateAndCancel()
        if oldSession != nil {
            onLink?(.idle)
        }
    }

    func takeSentCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let count = sent
        sent = 0
        return count
    }

    func offer(_ make: @escaping () -> CGImage?) {
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        guard running, open, let task else {
            lock.unlock()
            return
        }
        if busy {
            let stalled = now - lastAccepted > stallLimit
            lock.unlock()
            if stalled {
                fail(task, "send stalled, reconnecting")
            }
            return
        }
        guard now - lastAccepted >= minInterval else {
            lock.unlock()
            return
        }
        busy = true
        lastAccepted = now
        lock.unlock()
        encodeQueue.async { [weak self] in
            guard let self else { return }
            guard let image = make(), let data = JPEGEncoder.encode(image) else {
                self.finishSend(task, nil, counted: false)
                return
            }
            task.send(.data(data)) { [weak self] error in
                self?.finishSend(task, error, counted: error == nil)
            }
        }
    }

    private func finishSend(_ finished: URLSessionWebSocketTask, _ error: Error?, counted: Bool) {
        lock.lock()
        let current = finished === task
        if current {
            busy = false
            if counted {
                sent += 1
            }
        }
        lock.unlock()
        if current, let error {
            fail(finished, error.localizedDescription)
        }
    }

    private func connect() {
        lock.lock()
        guard running, task == nil, let url, let session else {
            lock.unlock()
            return
        }
        let next = session.webSocketTask(with: url)
        next.maximumMessageSize = 1 << 20
        task = next
        open = false
        busy = false
        lock.unlock()
        onLink?(.connecting)
        next.resume()
        receive(on: next)
    }

    private func receive(on current: URLSessionWebSocketTask) {
        current.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.fail(current, error.localizedDescription)
            case .success(let message):
                if case .string(let text) = message, let reply = Self.errorText(in: text) {
                    self.onError?("server: \(reply)")
                }
                self.receive(on: current)
            }
        }
    }

    private static func errorText(in text: String) -> String? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["type"] as? String == "error"
        else { return nil }
        return object["error"] as? String ?? "unknown error"
    }

    private func fail(_ failed: URLSessionWebSocketTask, _ message: String?) {
        lock.lock()
        guard running, failed === task else {
            lock.unlock()
            return
        }
        task = nil
        open = false
        busy = false
        attempt += 1
        let delay = min(8.0, 0.5 * pow(2.0, Double(attempt - 1)))
        lock.unlock()
        failed.cancel()
        if let message {
            onError?(message)
        }
        onLink?(.waiting)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.connect()
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        lock.lock()
        let current = running && webSocketTask === task
        if current {
            open = true
            attempt = 0
        }
        lock.unlock()
        if current {
            onLink?(.open)
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        let text = reason.flatMap { String(data: $0, encoding: .utf8) }.flatMap { $0.isEmpty ? nil : $0 }
        fail(webSocketTask, text ?? "server closed the connection (\(closeCode.rawValue))")
    }

    func urlSession(_ session: URLSession, task finished: URLSessionTask, didCompleteWithError error: Error?) {
        guard let socket = finished as? URLSessionWebSocketTask else { return }
        fail(socket, error?.localizedDescription ?? "connection ended")
    }
}
