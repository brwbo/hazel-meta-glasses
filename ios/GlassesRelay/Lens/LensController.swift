import Foundation
import MWDATCore
import Observation
import UIKit

@MainActor
@Observable
final class LensController {
    private(set) var isOn = false
    private(set) var card: LensCard = .idle
    private(set) var phase: LensDisplay.Phase = .off
    private(set) var serverLinked = false
    private(set) var blocker: String?
    private(set) var notice = ""
    private(set) var sends = 0
    private(set) var styleNote = ""

    @ObservationIgnored private let relay: RelayController
    @ObservationIgnored private let hub: GlassesSessionHub
    @ObservationIgnored private let feed = LensFeed()
    @ObservationIgnored private let display: LensDisplay
    @ObservationIgnored private var picker = LensPicker()
    @ObservationIgnored private var cache: [Int: LensPerson] = [:]
    @ObservationIgnored private var loading: Set<Int> = []
    @ObservationIgnored private var stale: Set<Int> = []
    @ObservationIgnored private var choice: LensPicker.Choice = .nobody
    @ObservationIgnored private var previewOpen = false
    @ObservationIgnored private var feeding = false
    @ObservationIgnored private var lastRefresh: TimeInterval = 0
    @ObservationIgnored private var clock: Task<Void, Never>?

    static let refreshInterval = 15.0

    init(relay: RelayController, hub: GlassesSessionHub) {
        self.relay = relay
        self.hub = hub
        self.display = LensDisplay(hub: hub)
        display.onPhase = { [weak self] phase in
            self?.phaseChanged(phase)
        }
        display.renderImage = { person in
            UserDefaults.standard.bool(forKey: "lensPresetOnly") ? nil : HazelCardView.render(person)
        }
        feed.onEvent = { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        clock = Task { [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    var statusLine: String {
        var parts: [String] = []
        switch phase {
        case .off: parts.append("Lens off")
        case .connecting: parts.append("Lens connecting")
        case .live: parts.append("Lens on")
        case .waiting(let text): parts.append("Lens waiting: \(text)")
        case .unsupported: parts.append("These glasses have no display")
        }
        if feeding {
            parts.append(serverLinked ? "server linked" : "server not reachable")
        }
        if !notice.isEmpty {
            parts.append(notice)
        }
        if isOn, !styleNote.isEmpty {
            parts.append(styleNote)
        }
        return parts.joined(separator: " · ")
    }

    func setOn(_ on: Bool) {
        guard on != isOn else { return }
        if on {
            guard ServerAddress(relay.address) != nil else {
                notice = "enter the server address first"
                return
            }
            guard blocker == nil else { return }
            notice = ""
            isOn = true
            hub.useMock = relay.useMockGlasses
            syncFeed()
            display.start()
            display.show(card)
        } else {
            isOn = false
            display.stop()
            syncFeed()
        }
    }

    func previewChanged(open: Bool) {
        previewOpen = open
        syncFeed()
        guard open, isOn else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            self?.display.refresh()
        }
    }

    private func syncFeed() {
        let wanted = isOn || previewOpen
        if wanted, !feeding {
            guard let server = ServerAddress(relay.address) else {
                notice = "enter the server address first"
                return
            }
            notice = ""
            feeding = true
            picker.reset()
            cache = [:]
            feed.start(server: server)
        } else if !wanted, feeding {
            feeding = false
            serverLinked = false
            feed.stop()
            picker.reset()
            cache = [:]
            loading = []
            stale = []
            choice = .nobody
            card = .idle
        }
    }

    private func handle(_ event: LensFeed.Event) {
        guard feeding else { return }
        switch event {
        case .link(let up):
            serverLinked = up
        case .faces(let faces):
            apply(picker.update(faces: faces, now: ProcessInfo.processInfo.systemUptime))
        case .personChanged(let id):
            reload(id)
        case .sessionChanged:
            cache.keys.forEach(reload)
        }
    }

    private func tick() {
        updateBlocker()
        guard feeding else { return }
        let now = ProcessInfo.processInfo.systemUptime
        apply(picker.tick(now: now))
        if isOn, case .person(_, true) = choice, now - lastRefresh >= Self.refreshInterval {
            lastRefresh = now
            display.refresh()
        }
        if sends != display.sends {
            sends = display.sends
        }
        let style = display.imageFailed
            ? "preset style (image send failed)"
            : display.imageSends > 0 ? "image style, last \(display.lastImageBytes / 1024) KB as PNG" : ""
        if style != styleNote {
            styleNote = style
        }
    }

    private func apply(_ next: LensPicker.Choice) {
        choice = next
        let wanted: LensCard
        switch next {
        case .nobody:
            wanted = .idle
        case .newFace:
            wanted = .newFace
        case .person(let id, _):
            if let person = cache[id] {
                wanted = .person(person)
            } else {
                load(id)
                if case .person = card {
                    wanted = .idle
                } else {
                    wanted = card
                }
            }
        }
        if wanted != card {
            card = wanted
            if isOn {
                display.show(wanted)
            }
        }
    }

    private func reload(_ id: Int) {
        guard cache[id] != nil || loading.contains(id) else { return }
        if loading.contains(id) {
            stale.insert(id)
        } else {
            load(id)
        }
    }

    private func load(_ id: Int) {
        guard !loading.contains(id) else { return }
        loading.insert(id)
        Task { @MainActor [weak self] in
            guard let self else { return }
            let record = try? await self.feed.person(id)
            var photo: Data?
            if let reference = record?.thumbUrl, let raw = await self.feed.resource(reference) {
                photo = Self.shrink(raw)
            }
            self.loading.remove(id)
            guard self.feeding else { return }
            if let record {
                self.cache[id] = LensFormat.person(record, photo: photo)
            } else {
                self.cache[id] = nil
            }
            if self.stale.remove(id) != nil {
                self.load(id)
            }
            self.apply(self.choice)
        }
    }

    private func phaseChanged(_ next: LensDisplay.Phase) {
        phase = next
        if next == .unsupported {
            isOn = false
            syncFeed()
        }
    }

    private func updateBlocker() {
        let next = currentBlocker()
        if next != blocker {
            blocker = next
        }
    }

    private func currentBlocker() -> String? {
        guard relay.toolkitReady else {
            return "The glasses toolkit failed to start."
        }
        if relay.useMockGlasses {
            return nil
        }
        let wearables = Wearables.shared
        let connected = wearables.devices
            .compactMap { wearables.deviceForIdentifier($0) }
            .filter { $0.linkState == .connected }
        if connected.isEmpty {
            return "Connect Meta Ray-Ban Display glasses to use the lens card."
        }
        if !connected.contains(where: { $0.supportsDisplay() }) {
            return "These glasses have no display. The lens card needs Meta Ray-Ban Display."
        }
        return nil
    }

    private static func shrink(_ raw: Data) -> Data? {
        guard let image = UIImage(data: raw), image.size.width > 0, image.size.height > 0 else { return nil }
        let side = CGFloat(LensCard.photoSide)
        let scale = max(side / image.size.width, side / image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let square = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(
                x: (side - size.width) / 2,
                y: (side - size.height) / 2,
                width: size.width,
                height: size.height
            ))
        }
        return square.jpegData(compressionQuality: 0.7)
    }
}
