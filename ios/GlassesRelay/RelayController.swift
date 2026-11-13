import Foundation
import MWDATCore
import Observation
import UIKit

@MainActor
@Observable
final class RelayController {
    var address = UserDefaults.standard.string(forKey: "serverAddress") ?? ""
    var source = SourceKind(rawValue: UserDefaults.standard.string(forKey: "source") ?? "") ?? .glasses
    var useMockGlasses = false

    private(set) var isRunning = false
    private(set) var link: FrameRelay.Link = .idle
    private(set) var framesPerSecond = 0
    private(set) var audioChunks = 0
    private(set) var note = ""
    private(set) var lastError = ""
    private(set) var registration: RegistrationState = .unavailable
    private(set) var glassesConnected = false

    @ObservationIgnored private let frames = FrameRelay()
    @ObservationIgnored private let audio = AudioRelay()
    @ObservationIgnored private var active: (any MediaSource)?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var run = 0
    @ObservationIgnored private let toolkitReady: Bool

    init(toolkitReady: Bool) {
        self.toolkitReady = toolkitReady
        frames.onLink = { [weak self] link in
            Task { @MainActor in self?.link = link }
        }
        frames.onError = { [weak self] message in
            Task { @MainActor in self?.fail(message) }
        }
        audio.onError = { [weak self] message in
            Task { @MainActor in self?.fail(message) }
        }
        audio.onPosted = { [weak self] _ in
            Task { @MainActor in self?.audioChunks += 1 }
        }
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.refresh()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    var canConnect: Bool {
        !isRunning && ServerAddress(address) != nil
    }

    var glassesText: String {
        if glassesConnected {
            return "Glasses connected"
        }
        return registration == .registered ? "Glasses not connected" : "Glasses not registered"
    }

    var statusLine: String {
        var parts = [glassesText]
        if isRunning {
            parts.append("server \(link.rawValue)")
            parts.append("\(framesPerSecond) fps")
            parts.append("audio chunks \(audioChunks)")
            if !note.isEmpty {
                parts.append(note)
            }
        } else {
            parts.append("stopped")
        }
        if !lastError.isEmpty {
            parts.append("last error: \(lastError)")
        }
        return parts.joined(separator: " · ")
    }

    func connect() {
        guard !isRunning else { return }
        guard let server = ServerAddress(address), let framesURL = server.framesURL, let audioURL = server.audioURL else {
            fail("enter the server address as host:port")
            return
        }
        guard toolkitReady || source != .glasses else {
            fail("glasses toolkit failed to start, use another source")
            return
        }
        UserDefaults.standard.set(address, forKey: "serverAddress")
        UserDefaults.standard.set(source.rawValue, forKey: "source")
        run += 1
        let current = run
        lastError = ""
        note = ""
        framesPerSecond = 0
        audioChunks = 0
        isRunning = true
        UIApplication.shared.isIdleTimerDisabled = true
        frames.start(url: framesURL)
        audio.start(url: audioURL)

        let report: @Sendable (SourceEvent) -> Void = { [weak self] event in
            Task { @MainActor in self?.handle(event, run: current) }
        }
        let chosen: any MediaSource
        switch source {
        case .glasses:
            chosen = GlassesSource(frames: frames, audio: audio, useMock: useMockGlasses, report: report)
        case .phone:
            chosen = PhoneCameraSource(frames: frames, audio: audio, report: report)
        case .pattern:
            chosen = TestPatternSource(frames: frames, audio: audio, report: report)
        }
        active = chosen
        startTask = Task { [weak self] in
            do {
                try await chosen.start()
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.run == current else { return }
                self.fail(error.localizedDescription)
                self.stop()
            }
        }
    }

    func stop() {
        guard isRunning else { return }
        run += 1
        isRunning = false
        startTask?.cancel()
        startTask = nil
        let ending = active
        active = nil
        frames.stop()
        audio.stop()
        framesPerSecond = 0
        note = ""
        UIApplication.shared.isIdleTimerDisabled = false
        Task {
            await ending?.stop()
        }
    }

    func handleCallback(_ url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
        else { return }
        guard toolkitReady else { return }
        Task {
            do {
                _ = try await Wearables.shared.handleUrl(url)
            } catch {
                self.fail(error.localizedDescription)
            }
        }
    }

    private func handle(_ event: SourceEvent, run eventRun: Int) {
        guard eventRun == run, isRunning else { return }
        switch event {
        case .note(let text):
            note = text
        case .error(let text):
            fail(text)
        case .ended(let text):
            if lastError.isEmpty {
                fail(text)
            }
            stop()
        }
    }

    func fail(_ message: String) {
        lastError = message
    }

    private func refresh() {
        if isRunning {
            let rate = frames.takeSentCount()
            if rate != framesPerSecond {
                framesPerSecond = rate
            }
        }
        guard toolkitReady else { return }
        let wearables = Wearables.shared
        let state = wearables.registrationState
        if state != registration {
            registration = state
        }
        let connected = wearables.devices.contains { wearables.deviceForIdentifier($0)?.linkState == .connected }
        if connected != glassesConnected {
            glassesConnected = connected
        }
    }
}
