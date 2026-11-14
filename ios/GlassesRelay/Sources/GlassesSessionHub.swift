import Foundation
import MWDATCore
import MWDATMockDevice

@MainActor
final class GlassesSessionHub {
    enum User: Hashable {
        case camera
        case display
    }

    struct Listener {
        let note: (String) -> Void
        let error: (String) -> Void
        let ended: (String) -> Void
    }

    var useMock = false

    private let wearables = Wearables.shared
    private let tokens = ListenerTokenBag()
    private var selector: AutoDeviceSelector?
    private var session: DeviceSession?
    private var listeners: [User: Listener] = [:]
    private var opening: Task<DeviceSession, Error>?
    private(set) var mockGlasses: (any MockGlasses)?

    var activeSession: DeviceSession? {
        guard let session, session.state == .started else { return nil }
        return session
    }

    func acquire(_ user: User, listener: Listener) async throws -> DeviceSession {
        listeners[user] = listener
        do {
            let session = try await open(note: listener.note)
            try Task.checkCancellation()
            if user == .display, session.device?.supportsDisplay() != true {
                throw RelayFailure("these glasses have no display")
            }
            return session
        } catch {
            release(user)
            throw error
        }
    }

    func release(_ user: User) {
        listeners[user] = nil
        guard listeners.isEmpty else { return }
        opening?.cancel()
        opening = nil
        close()
    }

    func prepareMock() throws {
        let kit = MockDeviceKit.shared
        if !kit.isEnabled {
            kit.enable()
        }
        guard mockGlasses == nil else { return }
        let plain = UserDefaults.standard.bool(forKey: "relayMockNoDisplay")
        let glasses = try kit.pairGlasses(model: plain ? .rayBanMeta : .metaRayBanDisplay)
        glasses.powerOn()
        glasses.unfold()
        glasses.don()
        if let path = UserDefaults.standard.string(forKey: "relayMockVideo") {
            glasses.services.camera.setCameraFeed(fileURL: URL(fileURLWithPath: path))
        } else {
            #if !targetEnvironment(simulator)
            glasses.services.camera.setCameraFeed(cameraFacing: .back)
            #endif
        }
        mockGlasses = glasses
    }

    private func open(note: @escaping (String) -> Void) async throws -> DeviceSession {
        if let activeSession {
            return activeSession
        }
        if let opening {
            return try await opening.value
        }
        let task = Task { @MainActor [weak self] () throws -> DeviceSession in
            guard let self else { throw CancellationError() }
            return try await self.create(note: note)
        }
        opening = task
        defer {
            if opening == task {
                opening = nil
            }
        }
        return try await task.value
    }

    private func create(note: (String) -> Void) async throws -> DeviceSession {
        close()
        if useMock {
            try prepareMock()
        } else if MockDeviceKit.shared.isEnabled {
            mockGlasses = nil
            await MockDeviceKit.shared.disable()
        }
        try await register(note: note)
        let selector = AutoDeviceSelector(wearables: wearables)
        self.selector = selector
        try await waitForDevice(selector)
        try Task.checkCancellation()

        let session = try wearables.createSession(deviceSelector: selector)
        self.session = session
        let states = session.stateStream()
        session.statePublisher.listen { [weak self] state in
            Task { @MainActor in
                self?.changed(state, of: session)
            }
        }.store(in: tokens)
        session.errorPublisher.listen { [weak self] error in
            let text = error.localizedDescription
            Task { @MainActor in
                self?.listeners.values.forEach { $0.error("glasses session: \(text)") }
            }
        }.store(in: tokens)
        try session.start()
        var started = false
        for await state in states {
            if state == .started {
                started = true
                break
            }
            if state == .stopped {
                break
            }
        }
        guard started, !Task.isCancelled else {
            if self.session === session {
                close()
            }
            throw Task.isCancelled ? CancellationError() : RelayFailure("glasses session did not start")
        }
        return session
    }

    private func close() {
        tokens.clear()
        session?.stop()
        session = nil
        selector = nil
    }

    private func changed(_ state: DeviceSessionState, of source: DeviceSession) {
        guard source === session else { return }
        if state == .stopped {
            tokens.clear()
            session = nil
            selector = nil
            let current = listeners.values
            current.forEach { $0.ended("glasses session stopped") }
        } else if state == .paused {
            listeners.values.forEach { $0.note("glasses session paused") }
        } else if state == .started {
            listeners.values.forEach { $0.note("glasses session resumed") }
        }
    }

    private func register(note: (String) -> Void) async throws {
        guard wearables.registrationState != .registered else { return }
        note("approve this app in Meta AI")
        let states = wearables.registrationStateStream()
        do {
            try await wearables.startRegistration()
        } catch RegistrationError.alreadyRegistered {
            return
        }
        for await state in states where state == .registered {
            return
        }
        throw CancellationError()
    }

    private func waitForDevice(_ selector: AutoDeviceSelector) async throws {
        for _ in 0..<40 {
            if selector.activeDevice != nil {
                return
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw RelayFailure("no glasses found: open them, wear them, check Developer Mode in Meta AI")
    }
}
