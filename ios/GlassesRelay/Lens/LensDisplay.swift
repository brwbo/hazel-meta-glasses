import Foundation
import MWDATCore
import MWDATDisplay
import UIKit

@MainActor
final class LensDisplay {
    enum Phase: Equatable {
        case off
        case connecting
        case live
        case waiting(String)
        case unsupported
    }

    var onPhase: ((Phase) -> Void)?
    private(set) var sends = 0

    private let hub: GlassesSessionHub
    private var display: Display?
    private var stateToken: (any AnyListenerToken)?
    private var connectTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var flushTask: Task<Void, Never>?
    private var wanted = false
    private var live = false
    private var sending = false
    private var attempt = 0
    private var card: LensCard = .idle
    private var lastSent: LensCard?
    private var lastSendAt: TimeInterval = 0

    init(hub: GlassesSessionHub) {
        self.hub = hub
    }

    func start() {
        guard !wanted else { return }
        wanted = true
        attempt = 0
        connect()
    }

    func stop() {
        wanted = false
        retryTask?.cancel()
        retryTask = nil
        teardown()
        onPhase?(.off)
    }

    func show(_ next: LensCard) {
        card = next
        flush()
    }

    func refresh() {
        lastSent = nil
        flush()
    }

    private func connect() {
        guard wanted else { return }
        onPhase?(.connecting)
        let listener = GlassesSessionHub.Listener(
            note: { [weak self] text in
                if text.hasSuffix("resumed") {
                    self?.refresh()
                }
            },
            error: { _ in },
            ended: { [weak self] text in
                self?.retry(text)
            }
        )
        connectTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let session = try await self.hub.acquire(.display, listener: listener)
                guard self.wanted, !Task.isCancelled else { return }
                let display = try session.addDisplay()
                self.display = display
                self.stateToken = display.statePublisher.listen { [weak self] state in
                    Task { @MainActor in
                        self?.changed(state, of: display)
                    }
                }
                display.start()
            } catch is CancellationError {
                return
            } catch let failure as RelayFailure where failure.message.contains("no display") {
                self.wanted = false
                self.teardown()
                self.onPhase?(.unsupported)
            } catch {
                self.retry(error.localizedDescription)
            }
        }
    }

    private func changed(_ state: DisplayState, of source: Display) {
        guard wanted, source === display else { return }
        switch state {
        case .started:
            live = true
            attempt = 0
            lastSent = nil
            onPhase?(.live)
            flush()
        case .stopped:
            retry("lens display stopped")
        case .starting, .stopping:
            break
        }
    }

    private func retry(_ reason: String) {
        guard wanted else { return }
        teardown()
        attempt += 1
        let delay = min(30, 1 << min(attempt, 5))
        onPhase?(.waiting("\(reason), retrying in \(delay) s"))
        retryTask?.cancel()
        retryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.connect()
        }
    }

    private func teardown() {
        connectTask?.cancel()
        connectTask = nil
        flushTask?.cancel()
        flushTask = nil
        stateToken = nil
        live = false
        sending = false
        lastSent = nil
        display?.stop()
        display = nil
        hub.release(.display)
    }

    private func flush() {
        guard live, !sending, let display, card != lastSent else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let wait = 1.0 - (now - lastSendAt)
        if wait > 0 {
            guard flushTask == nil else { return }
            flushTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                guard let self, !Task.isCancelled else { return }
                self.flushTask = nil
                self.flush()
            }
            return
        }
        let outgoing = card
        sending = true
        lastSendAt = now
        Task { @MainActor [weak self] in
            var failure: Error?
            do {
                try await display.send(Self.view(for: outgoing))
            } catch {
                failure = error
            }
            guard let self, self.display === display else { return }
            self.sending = false
            if let failure {
                self.retry((failure as? DisplayError)?.description ?? failure.localizedDescription)
                return
            }
            self.lastSent = outgoing
            self.sends += 1
            self.flush()
        }
    }

    static func view(for card: LensCard) -> FlexBox {
        switch card {
        case .idle:
            return line(icon: .eye, text: LensCard.idleText)
        case .newFace:
            return line(icon: .person, text: LensCard.newFaceText)
        case .person(let person):
            return personView(person)
        }
    }

    private static func line(icon: IconName, text: String) -> FlexBox {
        FlexBox(direction: .row, spacing: 8, crossAlignment: .center, padding: EdgeInsets(all: 16)) {
            Icon(name: icon, style: .outline)
            Text(text, style: .meta, color: .secondary)
        }
    }

    private static func personView(_ person: LensPerson) -> FlexBox {
        let photo = person.photo.flatMap { UIImage(data: $0) }
        return FlexBox(direction: .column, spacing: 12, padding: EdgeInsets(all: 24)) {
            FlexBox(direction: .row, spacing: 16, crossAlignment: .center) {
                if let photo {
                    FlexBox {
                        Image(image: photo, sizePreset: .fill, cornerRadius: .medium)
                    }
                    .flexGrow(1)
                }
                FlexBox(direction: .column, spacing: 4) {
                    Text(person.name, style: .heading)
                    if !person.role.isEmpty {
                        Text(person.role, style: .meta, color: .secondary)
                    }
                }
                .flexGrow(3)
            }
            if !person.summary.isEmpty {
                Text(person.summary, style: .body)
            }
            if !person.followup.isEmpty {
                FlexBox(direction: .row, spacing: 8, crossAlignment: .center) {
                    Icon(name: .checkmarkCircle, style: .outline)
                    FlexBox {
                        Text(person.followup, style: .meta)
                    }
                    .flexGrow(1)
                }
            }
        }
        .background(.card)
    }
}
