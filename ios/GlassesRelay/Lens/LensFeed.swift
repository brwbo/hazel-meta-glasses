import Foundation

final class LensFeed: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    enum Event: Sendable {
        case link(Bool)
        case faces([SeenFace])
        case personChanged(Int)
        case sessionChanged
    }

    var onEvent: (@Sendable (Event) -> Void)?

    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var server: ServerAddress?
    private var running = false
    private var attempt = 0

    func start(server: ServerAddress) {
        stop()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 8
        configuration.waitsForConnectivity = false
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        lock.lock()
        self.server = server
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        running = true
        attempt = 0
        lock.unlock()
        connect()
    }

    func stop() {
        lock.lock()
        let oldSession = session
        let oldTask = task
        running = false
        session = nil
        task = nil
        server = nil
        lock.unlock()
        oldTask?.cancel(with: .normalClosure, reason: nil)
        oldSession?.invalidateAndCancel()
    }

    func person(_ id: Int) async throws -> PersonRecord? {
        guard let (session, server) = current(), let url = server.personURL(id) else { return nil }
        let (data, response) = try await session.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try JSONDecoder().decode(PersonRecord.self, from: data)
    }

    func resource(_ reference: String) async -> Data? {
        guard let (session, server) = current(), let url = server.resourceURL(reference) else { return nil }
        guard let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              data.count <= 2_000_000
        else { return nil }
        return data
    }

    private func current() -> (URLSession, ServerAddress)? {
        lock.lock()
        defer { lock.unlock() }
        guard let session, let server else { return nil }
        return (session, server)
    }

    private func connect() {
        lock.lock()
        guard running, task == nil, let session, let url = server?.eventsURL else {
            lock.unlock()
            return
        }
        let next = session.webSocketTask(with: url)
        next.maximumMessageSize = 1 << 20
        task = next
        lock.unlock()
        next.resume()
        receive(on: next)
    }

    private func receive(on current: URLSessionWebSocketTask) {
        current.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.fail(current)
            case .success(let message):
                if case .string(let text) = message, let event = Self.event(from: text) {
                    self.onEvent?(event)
                }
                self.receive(on: current)
            }
        }
    }

    private static func event(from text: String) -> Event? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else { return nil }
        switch type {
        case "detections":
            let faces = (object["faces"] as? [[String: Any]] ?? []).compactMap(face)
            return .faces(faces)
        case "person", "transcript":
            guard let id = (object["id"] ?? object["personId"]) as? Int else { return nil }
            return .personChanged(id)
        case "session":
            return .sessionChanged
        default:
            return nil
        }
    }

    private static func face(_ object: [String: Any]) -> SeenFace? {
        guard let box = object["box"] as? [NSNumber], box.count == 4 else { return nil }
        return SeenFace(
            trackId: object["trackId"] as? Int ?? -1,
            personId: object["personId"] as? Int,
            area: box[2].doubleValue * box[3].doubleValue
        )
    }

    private func fail(_ failed: URLSessionWebSocketTask) {
        lock.lock()
        guard running, failed === task else {
            lock.unlock()
            return
        }
        task = nil
        attempt += 1
        let delay = min(8.0, 0.5 * pow(2.0, Double(attempt - 1)))
        lock.unlock()
        failed.cancel()
        onEvent?(.link(false))
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
            attempt = 0
        }
        lock.unlock()
        if current {
            onEvent?(.link(true))
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        fail(webSocketTask)
    }

    func urlSession(_ session: URLSession, task finished: URLSessionTask, didCompleteWithError error: Error?) {
        guard let socket = finished as? URLSessionWebSocketTask else { return }
        fail(socket)
    }
}
