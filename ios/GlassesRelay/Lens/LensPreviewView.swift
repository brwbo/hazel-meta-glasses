import SwiftUI
import UIKit

struct LensCardView: View {
    let card: LensCard

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color.black
            content
        }
        .frame(width: CGFloat(LensCard.side), height: CGFloat(LensCard.side))
        .clipped()
    }

    @ViewBuilder private var content: some View {
        switch card {
        case .idle:
            line(symbol: "eye", text: LensCard.idleText)
        case .newFace:
            line(symbol: "person", text: LensCard.newFaceText)
        case .person(let person):
            personView(person)
        }
    }

    private func line(symbol: String, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
            Text(text)
        }
        .font(.system(size: 24))
        .foregroundStyle(.white.opacity(0.7))
        .padding(16)
    }

    private func personView(_ person: LensPerson) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 16) {
                if let data = person.photo, let photo = UIImage(data: data) {
                    Image(uiImage: photo)
                        .resizable()
                        .aspectRatio(1, contentMode: .fill)
                        .frame(width: 132, height: 132)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(person.name)
                        .font(.system(size: 40, weight: .bold))
                        .foregroundStyle(.white)
                    if !person.role.isEmpty {
                        Text(person.role)
                            .font(.system(size: 24))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                }
            }
            if !person.summary.isEmpty {
                Text(person.summary)
                    .font(.system(size: 30))
                    .foregroundStyle(.white)
            }
            if !person.followup.isEmpty {
                HStack(alignment: .center, spacing: 8) {
                    Image(systemName: "checkmark.circle")
                    Text(person.followup)
                }
                .font(.system(size: 24))
                .foregroundStyle(.white)
            }
        }
        .padding(24)
        .frame(width: CGFloat(LensCard.side), alignment: .leading)
        .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 24))
    }
}

struct LensPreviewView: View {
    let lens: LensController
    let hub: GlassesSessionHub

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(lens.statusLine)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("Card (phone render)")
                    .font(.headline)
                scaled {
                    LensCardView(card: lens.card)
                }
                #if DEBUG
                if lens.phase == .live, let glasses = hub.mockGlasses {
                    Text("Simulated glasses display, sends: \(lens.sends)")
                        .font(.headline)
                        .monospacedDigit()
                    MockLensSurface(glasses: glasses)
                        .aspectRatio(1, contentMode: .fit)
                        .background(Color.black)
                        .accessibilityIdentifier("mockLens")
                }
                #endif
            }
            .frame(maxWidth: 300)
            .frame(maxWidth: .infinity)
            .padding(16)
        }
        .navigationTitle("Lens preview")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { lens.previewChanged(open: true) }
        .onDisappear { lens.previewChanged(open: false) }
    }

    private func scaled<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        let built = content()
        return GeometryReader { proxy in
            let factor = proxy.size.width / CGFloat(LensCard.side)
            built
                .scaleEffect(factor, anchor: .topLeading)
                .frame(width: proxy.size.width, height: proxy.size.width, alignment: .topLeading)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityIdentifier("lensPreview")
    }
}
