import AVFoundation

final class MicCapture {
    enum Route {
        case phone
        case glassesBluetooth
    }

    private let engine = AVAudioEngine()
    private var tapped = false

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start(route: Route, sink: @escaping (AVAudioPCMBuffer) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        switch route {
        case .phone:
            try session.setCategory(.playAndRecord, mode: .videoRecording, options: [.mixWithOthers, .defaultToSpeaker])
            try session.setActive(true)
        case .glassesBluetooth:
            try session.setCategory(.playAndRecord, mode: .videoRecording, options: [.allowBluetoothHFP, .mixWithOthers])
            try session.setActive(true)
            guard let input = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) else {
                throw RelayFailure("glasses microphone not available over Bluetooth")
            }
            try session.setPreferredInput(input)
            guard session.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }) else {
                throw RelayFailure("glasses microphone is not the active input")
            }
        }
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw RelayFailure("no usable microphone input")
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            sink(buffer)
        }
        tapped = true
        engine.prepare()
        try engine.start()
    }

    func stop() {
        if tapped {
            engine.inputNode.removeTap(onBus: 0)
            tapped = false
        }
        if engine.isRunning {
            engine.stop()
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
