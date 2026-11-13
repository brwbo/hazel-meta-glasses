import AVFoundation
import Foundation

final class AudioRelay: @unchecked Sendable {
    static let sampleRate = 16_000.0
    static let chunkSeconds = 8.0

    var onPosted: (@Sendable (Bool) -> Void)?
    var onError: (@Sendable (String) -> Void)?

    private let lock = NSLock()
    private let target = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: AudioRelay.sampleRate,
        channels: 1,
        interleaved: true
    )
    private let chunkBytes = Int(AudioRelay.sampleRate * AudioRelay.chunkSeconds) * 2
    private var session: URLSession?
    private var url: URL?
    private var converter: AVAudioConverter?
    private var pcm = Data()
    private var inFlight = 0

    func start(url: URL) {
        stop()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 30
        lock.lock()
        self.url = url
        session = URLSession(configuration: configuration)
        pcm = Data()
        pcm.reserveCapacity(chunkBytes)
        inFlight = 0
        lock.unlock()
    }

    func stop() {
        lock.lock()
        let oldSession = session
        session = nil
        url = nil
        converter = nil
        pcm = Data()
        lock.unlock()
        oldSession?.invalidateAndCancel()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0, let target else { return }
        lock.lock()
        guard session != nil else {
            lock.unlock()
            return
        }
        if converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: target)
        }
        guard let converter else {
            lock.unlock()
            onError?("audio format not supported")
            return
        }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            lock.unlock()
            return
        }
        var consumed = false
        var failure: NSError?
        converter.convert(to: output, error: &failure) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if failure == nil, output.frameLength > 0, let samples = output.int16ChannelData?[0] {
            pcm.append(UnsafeBufferPointer(start: samples, count: Int(output.frameLength)))
        }
        var chunk: Data?
        if pcm.count >= chunkBytes {
            chunk = pcm.prefix(chunkBytes)
            pcm = Data(pcm.dropFirst(chunkBytes))
        }
        lock.unlock()
        if let chunk {
            post(chunk)
        }
    }

    static func wav(pcm: Data) -> Data {
        let rate = UInt32(sampleRate)
        var data = Data(capacity: pcm.count + 44)
        func put<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: Array("RIFF".utf8))
        put(UInt32(36 + pcm.count))
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        put(UInt32(16))
        put(UInt16(1))
        put(UInt16(1))
        put(rate)
        put(rate * 2)
        put(UInt16(2))
        put(UInt16(16))
        data.append(contentsOf: Array("data".utf8))
        put(UInt32(pcm.count))
        data.append(pcm)
        return data
    }

    private func post(_ chunk: Data) {
        lock.lock()
        guard let session, let url, inFlight < 2 else {
            lock.unlock()
            return
        }
        inFlight += 1
        lock.unlock()
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        let task = session.uploadTask(with: request, from: Self.wav(pcm: chunk)) { [weak self] body, response, error in
            guard let self else { return }
            self.lock.lock()
            self.inFlight = max(0, self.inFlight - 1)
            let active = self.session != nil
            self.lock.unlock()
            guard active else { return }
            if let error {
                self.onError?("audio upload: \(error.localizedDescription)")
                return
            }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200...299).contains(code) else {
                self.onError?("audio upload: HTTP \(code)")
                return
            }
            let object = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            self.onPosted?(object?["stored"] as? Bool ?? (code != 202))
        }
        task.resume()
    }
}
