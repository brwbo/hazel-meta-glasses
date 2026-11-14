import Foundation

struct LensPerson: Equatable {
    let id: Int
    let name: String
    let role: String
    let facts: [String]
    let photo: Data?
}

enum LensCard: Equatable {
    case idle
    case newFace
    case person(LensPerson)

    static let side = 600
    static let photoSide = 160
    static let factLimit = 34
    static let factCount = 3
    static let idleText = "Watching"
    static let newFaceText = "New face"
}

struct PersonRecord: Decodable {
    let id: Int
    let name: String?
    let role: String?
    let notes: [PersonNote]?
    let thumbUrl: String?
}

struct PersonNote: Decodable {
    let ts: Double?
    let text: String?
}

enum LensFormat {
    static func person(_ record: PersonRecord, photo: Data?) -> LensPerson {
        LensPerson(
            id: record.id,
            name: clip(record.name ?? "", to: 40),
            role: clip(record.role ?? "", to: 60),
            facts: LensFacts.derive(from: record.notes ?? []),
            photo: photo
        )
    }

    static func clip(_ text: String, to limit: Int) -> String {
        let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard flat.count > limit else { return flat }
        let head = flat.prefix(limit - 1)
        if let space = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: space) > limit / 2 {
            return String(head[..<space]) + "…"
        }
        return String(head) + "…"
    }
}
