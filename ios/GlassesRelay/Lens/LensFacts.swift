import Foundation

enum LensFacts {
    private static let intro = pattern("^(hello|hi|hey)?,? ?my name( is|'s)")
    private static let factual = pattern(
        "born in|i'?m from|i am from|live in|living in|based in|work(ing)? (as|at|for)|i'?m an? |i am an? |studying"
    )
    private static let rewrites: [(NSRegularExpression, String)] = [
        (pattern("^i( was| am|'m) (born|from|based|living|working|studying)\\b"), "$2"),
        (pattern("^i( am|'m) an? "), ""),
        (pattern("^i live in\\b"), "Lives in"),
        (pattern("^i work (as|at|for)\\b"), "Works $1"),
        (pattern("^i study\\b"), "Studies")
    ]

    static func derive(from notes: [PersonNote]) -> [String] {
        let usable = notes
            .compactMap { note -> (Double, String)? in
                guard let text = note.text else { return nil }
                let flat = flatten(text)
                guard !flat.isEmpty,
                      !flat.lowercased().hasPrefix("named from speech"),
                      !matches(intro, flat)
                else { return nil }
                return (note.ts ?? 0, flat)
            }
        let facts = usable.filter { matches(factual, $0.1) }.sorted { $0.0 < $1.0 }
        let others = usable.filter { !matches(factual, $0.1) }.sorted { $0.0 > $1.0 }
        var result: [String] = []
        for (_, text) in facts + others {
            let line = tidy(text)
            guard !line.isEmpty, !result.contains(line) else { continue }
            result.append(line)
            if result.count == LensCard.factCount {
                break
            }
        }
        return result
    }

    static func tidy(_ text: String) -> String {
        var line = flatten(text).replacingOccurrences(of: "’", with: "'")
        if let stop = line.range(of: ". ") {
            line = String(line[..<stop.lowerBound])
        }
        for (expression, template) in rewrites {
            let range = NSRange(line.startIndex..., in: line)
            if expression.firstMatch(in: line, range: range) != nil {
                line = expression.stringByReplacingMatches(in: line, range: range, withTemplate: template)
                break
            }
        }
        while let last = line.last, ".…,;: ".contains(last) {
            line.removeLast()
        }
        line = line.trimmingCharacters(in: .whitespaces)
        if let first = line.first {
            line = first.uppercased() + line.dropFirst()
        }
        return LensFormat.clip(line, to: LensCard.factLimit)
    }

    private static func flatten(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func matches(_ expression: NSRegularExpression, _ text: String) -> Bool {
        let plain = text.replacingOccurrences(of: "’", with: "'")
        return expression.firstMatch(in: plain, range: NSRange(plain.startIndex..., in: plain)) != nil
    }

    private static func pattern(_ source: String) -> NSRegularExpression {
        (try? NSRegularExpression(pattern: source, options: [.caseInsensitive])) ?? NSRegularExpression()
    }
}
