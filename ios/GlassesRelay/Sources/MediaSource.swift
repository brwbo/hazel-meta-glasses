import Foundation

enum SourceEvent: Sendable {
    case note(String)
    case error(String)
    case ended(String)
}

protocol MediaSource: AnyObject {
    func start() async throws
    func stop() async
}

struct RelayFailure: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

enum SourceKind: String, CaseIterable, Identifiable {
    case glasses
    case phone
    case pattern

    var id: String { rawValue }

    var title: String {
        switch self {
        case .glasses: return "Glasses"
        case .phone: return "Phone camera"
        case .pattern: return "Test pattern"
        }
    }
}
