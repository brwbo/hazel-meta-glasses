import Foundation

struct ServerAddress: Equatable {
    let host: String
    let port: Int

    init?(_ text: String) {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["ws://", "http://"] where value.lowercased().hasPrefix(prefix) {
            value = String(value.dropFirst(prefix.count))
        }
        if let slash = value.firstIndex(of: "/") {
            value = String(value[..<slash])
        }
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2, let first = parts.first, !first.isEmpty else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-"))
        guard first.unicodeScalars.allSatisfy({ allowed.contains($0) && $0.isASCII }) else { return nil }
        var port = 8800
        if parts.count == 2 {
            guard let parsed = Int(parts[1]), (1...65535).contains(parsed) else { return nil }
            port = parsed
        }
        self.host = String(first)
        self.port = port
    }

    var framesURL: URL? { url(scheme: "ws", path: "/ingest") }
    var audioURL: URL? { url(scheme: "http", path: "/api/ingest/audio") }

    private func url(scheme: String, path: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        components.path = path
        return components.url
    }
}
