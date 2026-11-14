import AVFoundation
import CoreGraphics
import MWDATCamera
import MWDATCore
import UIKit
import VideoToolbox

@MainActor
final class GlassesSource: MediaSource {
    private let frames: FrameRelay
    private let audio: AudioRelay
    private let report: @Sendable (SourceEvent) -> Void
    private let useMock: Bool
    private let hub: GlassesSessionHub
    private let wearables = Wearables.shared
    private let streamTokens = ListenerTokenBag()
    private let mic = MicCapture()
    private var session: DeviceSession?
    private var camera: MWDATCamera.Camera?
    private var stopping = false
    private var streamWasActive = false
    private var usingToolkitAudio = false

    init(
        frames: FrameRelay,
        audio: AudioRelay,
        hub: GlassesSessionHub,
        report: @escaping @Sendable (SourceEvent) -> Void
    ) {
        self.frames = frames
        self.audio = audio
        self.hub = hub
        self.useMock = hub.useMock
        self.report = report
    }

    func start() async throws {
        stopping = false
        streamWasActive = false
        let report = self.report
        let listener = GlassesSessionHub.Listener(
            note: { report(.note($0)) },
            error: { report(.error($0)) },
            ended: { [weak self] text in
                guard let self, !self.stopping else { return }
                report(.ended(text))
            }
        )
        let session = try await hub.acquire(.camera, listener: listener)
        self.session = session
        guard try await permission(.camera) else {
            throw RelayFailure("camera permission for the glasses was not granted in Meta AI")
        }
        var toolkitAudio = false
        if !useMock {
            do {
                toolkitAudio = try await permission(.microphone)
            } catch {
                report(.error("glasses microphone permission: \(error.localizedDescription)"))
            }
        }
        try Task.checkCancellation()
        try await attachCamera(to: session, toolkitAudio: toolkitAudio)
    }

    private func attachCamera(to session: DeviceSession, toolkitAudio: Bool) async throws {
        let config = StreamConfiguration(
            videoCodec: .raw,
            audioCodec: toolkitAudio ? .pcm(sampleRate: .rate16000, numberOfChannels: 1) : nil,
            resolution: .low,
            frameRate: 15
        )
        guard let camera = try session.addCamera(config: config) else {
            throw RelayFailure("could not attach the glasses camera")
        }
        self.camera = camera
        usingToolkitAudio = toolkitAudio
        streamWasActive = false
        let stream = camera.stream
        let frames = self.frames
        let audio = self.audio
        let report = self.report
        stream.statePublisher.listen { [weak self] state in
            Task { @MainActor in
                self?.streamChanged(state, of: camera)
            }
        }.store(in: streamTokens)
        stream.errorPublisher.listen { error in
            report(.error("glasses stream: \(error.localizedDescription)"))
        }.store(in: streamTokens)
        stream.videoFramePublisher.listen { frame in
            frames.offer {
                Self.image(from: frame)
            }
        }.store(in: streamTokens)
        if toolkitAudio {
            stream.audioFramePublisher.listen { frame in
                audio.append(frame.pcmBuffer)
            }.store(in: streamTokens)
        }
        stream.start()

        if !toolkitAudio, !useMock {
            await startBluetoothMic()
        }
    }

    func stop() {
        stopping = true
        streamTokens.clear()
        mic.stop()
        camera?.stop()
        camera = nil
        session = nil
        hub.release(.camera)
    }

    private func permission(_ kind: Permission) async throws -> Bool {
        if try await wearables.checkPermissionStatus(kind) == .granted {
            return true
        }
        report(.note("grant \(kind == .camera ? "camera" : "microphone") access in Meta AI"))
        return try await wearables.requestPermission(kind) == .granted
    }

    private func startBluetoothMic() async {
        guard await MicCapture.requestPermission() else {
            report(.error("microphone access denied, sending video only"))
            return
        }
        do {
            let audio = self.audio
            try mic.start(route: .glassesBluetooth) { audio.append($0) }
        } catch {
            report(.error("glasses audio: \(error.localizedDescription), sending video only"))
        }
    }

    private func streamChanged(_ state: StreamState, of source: MWDATCamera.Camera) {
        guard !stopping, source === camera else { return }
        if state == .stopped {
            guard streamWasActive else { return }
            if usingToolkitAudio, let session, session.state == .started {
                retryWithoutToolkitAudio(on: session)
            } else {
                report(.ended("glasses stream stopped"))
            }
            return
        }
        streamWasActive = true
        report(.note("glasses stream \(Self.text(state))"))
    }

    private func retryWithoutToolkitAudio(on session: DeviceSession) {
        report(.note("retrying without toolkit audio"))
        streamTokens.clear()
        camera?.stop()
        camera = nil
        Task { @MainActor [weak self] in
            guard let self, !self.stopping else { return }
            do {
                try await self.attachCamera(to: session, toolkitAudio: false)
            } catch {
                self.report(.ended("glasses stream: \(error.localizedDescription)"))
            }
        }
    }

    nonisolated private static func text(_ state: StreamState) -> String {
        switch state {
        case .streaming: return "streaming"
        case .starting: return "starting"
        case .waitingForDevice: return "waiting for device"
        case .stopping: return "stopping"
        case .stopped: return "stopped"
        case .paused: return "paused"
        }
    }

    nonisolated private static func image(from frame: VideoFrame) -> CGImage? {
        if let picture = frame.makeUIImage() {
            if picture.imageOrientation == .up, let direct = picture.cgImage {
                return direct
            }
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let upright = UIGraphicsImageRenderer(size: picture.size, format: format).image { _ in
                picture.draw(in: CGRect(origin: .zero, size: picture.size))
            }
            if let drawn = upright.cgImage {
                return drawn
            }
        }
        guard let pixels = CMSampleBufferGetImageBuffer(frame.sampleBuffer) else { return nil }
        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(pixels, options: nil, imageOut: &image)
        return image
    }
}
