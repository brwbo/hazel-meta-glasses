import Foundation

struct SeenFace: Equatable {
    let trackId: Int
    let personId: Int?
    let area: Double
}

struct LensPicker {
    enum Choice: Equatable {
        case nobody
        case newFace
        case person(id: Int, inView: Bool)
    }

    static let dwell = 0.8
    static let switchDelay = 1.2
    static let linger = 6.0
    static let grace = 0.5

    private struct Sighting {
        var since: TimeInterval
        var last: TimeInterval
        var area: Double
    }

    private var people: [Int: Sighting] = [:]
    private var strangers: [Int: Sighting] = [:]
    private var current: Int?
    private var currentLast: TimeInterval = 0
    private var challenger: (id: Int, since: TimeInterval)?

    mutating func update(faces: [SeenFace], now: TimeInterval) -> Choice {
        for face in faces {
            if let id = face.personId {
                var sighting = people[id] ?? Sighting(since: now, last: now, area: 0)
                sighting.area = sighting.last == now ? max(sighting.area, face.area) : face.area
                sighting.last = now
                people[id] = sighting
            } else {
                var sighting = strangers[face.trackId] ?? Sighting(since: now, last: now, area: 0)
                sighting.last = now
                sighting.area = face.area
                strangers[face.trackId] = sighting
            }
        }
        return settle(now: now)
    }

    mutating func tick(now: TimeInterval) -> Choice {
        settle(now: now)
    }

    mutating func reset() {
        self = LensPicker()
    }

    private mutating func settle(now: TimeInterval) -> Choice {
        people = people.filter { now - $0.value.last <= Self.grace }
        strangers = strangers.filter { now - $0.value.last <= Self.grace }

        let dominant = people
            .filter { now - $0.value.since >= Self.dwell }
            .max { ($0.value.area, -$0.key) < ($1.value.area, -$1.key) }?
            .key

        if let shown = current {
            if people[shown] != nil {
                currentLast = now
            }
            if now - currentLast > Self.linger {
                current = nil
                challenger = nil
            }
        }

        if let shown = current {
            if let dominant, dominant != shown {
                if challenger?.id != dominant {
                    challenger = (dominant, now)
                }
                if let rival = challenger, now - rival.since >= Self.switchDelay {
                    current = dominant
                    currentLast = now
                    challenger = nil
                }
            } else {
                challenger = nil
            }
        } else if let dominant {
            current = dominant
            currentLast = now
            challenger = nil
        }

        if let shown = current {
            return .person(id: shown, inView: people[shown] != nil)
        }
        if strangers.contains(where: { now - $0.value.since >= Self.dwell }) {
            return .newFace
        }
        return .nobody
    }
}
