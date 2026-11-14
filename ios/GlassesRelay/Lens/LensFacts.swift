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

    private static let placeholders = ["introduced themselves", "spoke about", "spoke with"]
    private static let leadingName = pattern("^[A-Z][\\w'-]*( [A-Z][\\w'-]*){0,3}(?= (is|was) )", sensitive: true)
    private static let pronoun = pattern("^(he|she|they)( is| are| was| were)? ")
    private static let copula = pattern("^(is an? |is |was (?=born )|was an? |was )")
    private static let breaks = pattern(
        ",\\s*| and | (?=(born in|working|living|lives in|works|studies|from) )"
    )

    static func derive(summary: String, name: String, notes: [PersonNote]) -> [String] {
        let fromSummary = clauses(in: summary, name: name)
        return fromSummary.isEmpty ? derive(from: notes) : fromSummary
    }

    static func clauses(in summary: String, name: String) -> [String] {
        let flat = flatten(summary).replacingOccurrences(of: "’", with: "'")
        guard !flat.isEmpty else { return [] }
        var result: [String] = []
        for (index, sentence) in flat.components(separatedBy: ". ").enumerated() {
            var rest = sentence.trimmingCharacters(in: .whitespaces)
            if index == 0 {
                rest = dropName(from: rest, name: flatten(name))
            } else {
                rest = replace(pronoun, in: rest, with: "")
            }
            let lowered = rest.lowercased()
            if placeholders.contains(where: { lowered.hasPrefix($0) }) {
                continue
            }
            rest = replace(copula, in: rest, with: "")
            for piece in replace(breaks, in: rest, with: "\n").components(separatedBy: "\n") {
                let line = finish(piece)
                guard line.count >= 3, !result.contains(line) else { continue }
                result.append(line)
                if result.count == LensCard.factCount {
                    return result
                }
            }
        }
        return result
    }

    private static func dropName(from sentence: String, name: String) -> String {
        if !name.isEmpty, sentence.lowercased().hasPrefix(name.lowercased() + " ") {
            return String(sentence.dropFirst(name.count + 1))
        }
        if let first = name.split(separator: " ").first, sentence.lowercased().hasPrefix(first.lowercased() + " ") {
            return String(sentence.dropFirst(first.count + 1))
        }
        let stripped = replace(leadingName, in: sentence, with: "")
        return stripped.trimmingCharacters(in: .whitespaces)
    }

    private static func finish(_ text: String) -> String {
        var line = text.trimmingCharacters(in: .whitespaces)
        while let last = line.last, ".…,;: ".contains(last) {
            line.removeLast()
        }
        if let first = line.first {
            line = first.uppercased() + line.dropFirst()
        }
        return LensFormat.clip(line, to: LensCard.factLimit)
    }

    private static func replace(_ expression: NSRegularExpression, in text: String, with template: String) -> String {
        expression.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

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

    private static func pattern(_ source: String, sensitive: Bool = false) -> NSRegularExpression {
        (try? NSRegularExpression(pattern: source, options: sensitive ? [] : [.caseInsensitive])) ?? NSRegularExpression()
    }
}
