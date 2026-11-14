import CoreText
import SwiftUI
import UIKit

enum Hazel {
    static let paper = Color(red: 0xF6 / 255, green: 0xF0 / 255, blue: 0xE3 / 255)
    static let paperTop = Color(red: 0xFF / 255, green: 0xFD / 255, blue: 0xF8 / 255)
    static let sheen = Color(red: 0xF8 / 255, green: 0xF2 / 255, blue: 0xE6 / 255)
    static let paperDeep = Color(red: 0xED / 255, green: 0xE4 / 255, blue: 0xD1 / 255)
    static let ink = Color(red: 0x23 / 255, green: 0x28 / 255, blue: 0x1F / 255)
    static let inkSoft = Color(red: 0x3F / 255, green: 0x46 / 255, blue: 0x38 / 255)
    static let muted = Color(red: 0x66 / 255, green: 0x6C / 255, blue: 0x5C / 255)
    static let rule = Color(red: 0xDD / 255, green: 0xD3 / 255, blue: 0xBD / 255)
    static let accent = Color(red: 0x4F / 255, green: 0x6B / 255, blue: 0x4A / 255)
    static let radius: CGFloat = 30

    private static let files = ["young-serif-400", "hanken-grotesk-400", "hanken-grotesk-600"]
    private static let registered: Bool = {
        var loaded = true
        for name in files {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else {
                loaded = false
                continue
            }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        return loaded && UIFont(name: "YoungSerif-Regular", size: 12) != nil
    }()

    static var fontsReady: Bool { registered }

    static func display(_ size: CGFloat) -> Font {
        registered ? .custom("YoungSerif-Regular", fixedSize: size) : .system(size: size, design: .serif)
    }

    static func body(_ size: CGFloat) -> Font {
        registered ? .custom("HankenGrotesk-Regular", fixedSize: size) : .system(size: size)
    }

    static func strong(_ size: CGFloat) -> Font {
        registered ? .custom("HankenGrotesk-SemiBold", fixedSize: size) : .system(size: size, weight: .semibold)
    }
}

struct HazelCardView: View {
    let person: LensPerson

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .center, spacing: 22) {
                photo
                VStack(alignment: .leading, spacing: 4) {
                    Text(person.name)
                        .font(Hazel.display(46))
                        .tracking(-0.9)
                        .foregroundStyle(Hazel.ink)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if !person.role.isEmpty {
                        Text(person.role)
                            .font(Hazel.strong(25))
                            .foregroundStyle(Hazel.accent)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !person.facts.isEmpty {
                Rectangle()
                    .fill(Hazel.rule)
                    .frame(height: 1.5)
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(person.facts.enumerated()), id: \.offset) { _, fact in
                        HStack(alignment: .firstTextBaseline, spacing: 14) {
                            Circle()
                                .fill(Hazel.accent)
                                .frame(width: 11, height: 11)
                                .alignmentGuide(.firstTextBaseline) { $0[.bottom] + 7 }
                            Text(fact)
                                .font(Hazel.body(30))
                                .foregroundStyle(Hazel.ink)
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
        .padding(28)
        .frame(width: CGFloat(LensCard.side), alignment: .leading)
        .background(
            LinearGradient(
                stops: [.init(color: Hazel.paperTop, location: 0), .init(color: Hazel.paperTop, location: 0.62),
                        .init(color: Hazel.sheen, location: 1)],
                startPoint: .top,
                endPoint: .bottom
            ),
            in: RoundedRectangle(cornerRadius: Hazel.radius)
        )
        .background(Color.black)
    }

    @ViewBuilder private var photo: some View {
        if let data = person.photo, let picture = UIImage(data: data) {
            Image(uiImage: picture)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 136, height: 136)
                .clipShape(RoundedRectangle(cornerRadius: 36))
                .padding(5)
                .background(Hazel.paperTop, in: RoundedRectangle(cornerRadius: 41))
                .padding(1.5)
                .background(Hazel.rule, in: RoundedRectangle(cornerRadius: 42.5))
        }
    }

    @MainActor
    static func render(_ person: LensPerson) -> UIImage? {
        let renderer = ImageRenderer(content: HazelCardView(person: person))
        renderer.scale = 1
        renderer.isOpaque = true
        renderer.proposedSize = ProposedViewSize(width: CGFloat(LensCard.side), height: nil)
        guard let image = renderer.uiImage,
              Int(image.size.width) == LensCard.side,
              image.size.height > 0,
              Int(image.size.height) <= LensCard.side
        else { return nil }
        return image
    }
}
