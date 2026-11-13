import AVFoundation
import CoreGraphics
import Foundation

final class TestPatternSource: MediaSource, @unchecked Sendable {
    private let frames: FrameRelay
    private let audio: AudioRelay
    private let queue = DispatchQueue(label: "glassesrelay.pattern")
    private var timer: DispatchSourceTimer?
    private var tick = 0
    private var phase = 0.0

    init(frames: FrameRelay, audio: AudioRelay, report: @escaping @Sendable (SourceEvent) -> Void) {
        self.frames = frames
        self.audio = audio
        report(.note("test pattern"))
    }

    func start() async throws {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1.0 / 12.0)
        timer.setEventHandler { [weak self] in
            self?.step()
        }
        queue.sync {
            self.timer = timer
        }
        timer.resume()
    }

    func stop() {
        queue.sync {
            timer?.cancel()
            timer = nil
        }
    }

    private func step() {
        tick += 1
        let index = tick
        frames.offer {
            Self.render(index)
        }
        if let tone = tone(seconds: 1.0 / 12.0) {
            audio.append(tone)
        }
    }

    private func tone(seconds: Double) -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: AudioRelay.sampleRate, channels: 1) else {
            return nil
        }
        let count = AVAudioFrameCount((AudioRelay.sampleRate * seconds).rounded())
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count),
              let samples = buffer.floatChannelData?[0]
        else { return nil }
        buffer.frameLength = count
        let increment = 2.0 * Double.pi * 440.0 / AudioRelay.sampleRate
        for frame in 0..<Int(count) {
            samples[frame] = Float(sin(phase)) * 0.2
            phase += increment
        }
        phase = phase.truncatingRemainder(dividingBy: 2.0 * Double.pi)
        return buffer
    }

    static func render(_ index: Int) -> CGImage? {
        let width = 640
        let height = 480
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        let bars: [(CGFloat, CGFloat, CGFloat)] = [
            (0.75, 0.75, 0.75), (0.75, 0.75, 0), (0, 0.75, 0.75), (0, 0.75, 0),
            (0.75, 0, 0.75), (0.75, 0, 0), (0, 0, 0.75), (0.1, 0.1, 0.1)
        ]
        let barWidth = CGFloat(width) / CGFloat(bars.count)
        let shift = index % bars.count
        for (slot, _) in bars.enumerated() {
            let color = bars[(slot + shift / 4) % bars.count]
            context.setFillColor(red: color.0, green: color.1, blue: color.2, alpha: 1)
            context.fill(CGRect(x: CGFloat(slot) * barWidth, y: 0, width: barWidth + 1, height: CGFloat(height)))
        }
        let size: CGFloat = 80
        let travelX = CGFloat(width) - size
        let travelY = CGFloat(height) - size
        let x = abs(CGFloat((index * 9) % Int(travelX * 2)) - travelX)
        let y = abs(CGFloat((index * 6) % Int(travelY * 2)) - travelY)
        context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        context.fill(CGRect(x: x, y: y, width: size, height: size))
        context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: x + 20, y: y + 20, width: size - 40, height: size - 40))
        return context.makeImage()
    }
}
