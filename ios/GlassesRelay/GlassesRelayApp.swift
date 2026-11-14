import MWDATCore
import SwiftUI

@main
struct GlassesRelayApp: App {
    @State private var relay: RelayController
    @State private var lens: LensController
    private let hub: GlassesSessionHub

    init() {
        var startupError: String?
        do {
            try Wearables.configure()
        } catch {
            startupError = "glasses toolkit: \(error.localizedDescription)"
        }
        let hub = GlassesSessionHub()
        let controller = RelayController(toolkitReady: startupError == nil, hub: hub)
        let lens = LensController(relay: controller, hub: hub)
        if let startupError {
            controller.fail(startupError)
        }
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let flag = arguments.firstIndex(of: "-relayAutostart"), arguments.indices.contains(flag + 1) {
            controller.address = arguments[flag + 1]
            controller.source = .pattern
            Task { @MainActor in
                controller.connect()
            }
        }
        if let flag = arguments.firstIndex(of: "-lensAutostart"), arguments.indices.contains(flag + 1) {
            controller.address = arguments[flag + 1]
            controller.useMockGlasses = true
            Task { @MainActor in
                lens.setOn(true)
            }
        }
        #endif
        self.hub = hub
        _relay = State(initialValue: controller)
        _lens = State(initialValue: lens)
    }

    var body: some Scene {
        WindowGroup {
            ContentView(relay: relay, lens: lens, hub: hub)
                .onOpenURL { url in
                    relay.handleCallback(url)
                }
        }
    }
}
