import AVFoundation
import CoreGraphics
import VideoToolbox

final class PhoneCameraSource: NSObject, MediaSource, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let frames: FrameRelay
    private let audio: AudioRelay
    private let report: @Sendable (SourceEvent) -> Void
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "glassesrelay.camera")
    private let mic = MicCapture()

    init(frames: FrameRelay, audio: AudioRelay, report: @escaping @Sendable (SourceEvent) -> Void) {
        self.frames = frames
        self.audio = audio
        self.report = report
    }

    func start() async throws {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            throw RelayFailure("camera access denied, allow it in Settings")
        }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw RelayFailure("no back camera on this device")
        }
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        capture.beginConfiguration()
        capture.sessionPreset = .vga640x480
        guard capture.canAddInput(input), capture.canAddOutput(output) else {
            capture.commitConfiguration()
            throw RelayFailure("could not configure the phone camera")
        }
        capture.addInput(input)
        capture.addOutput(output)
        if let connection = output.connection(with: .video), connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }
        capture.commitConfiguration()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async {
                self.capture.startRunning()
                done.resume()
            }
        }
        report(.note("phone camera"))
        if await MicCapture.requestPermission() {
            do {
                let audio = self.audio
                try mic.start(route: .phone) { audio.append($0) }
            } catch {
                report(.error("microphone: \(error.localizedDescription)"))
            }
        } else {
            report(.error("microphone access denied, sending video only"))
        }
    }

    func stop() {
        mic.stop()
        queue.async {
            if self.capture.isRunning {
                self.capture.stopRunning()
            }
            self.capture.beginConfiguration()
            self.capture.inputs.forEach { self.capture.removeInput($0) }
            self.capture.outputs.forEach { self.capture.removeOutput($0) }
            self.capture.commitConfiguration()
        }
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        frames.offer {
            var image: CGImage?
            VTCreateCGImageFromCVPixelBuffer(pixels, options: nil, imageOut: &image)
            return image
        }
    }
}
