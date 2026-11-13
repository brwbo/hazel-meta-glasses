import MWDATCore
import SwiftUI

@main
struct GlassesRelayApp: App {
    @State private var relay: RelayController

    init() {
        var startupError: String?
        do {
            try Wearables.configure()
        } catch {
            startupError = "glasses toolkit: \(error.localizedDescription)"
        }
        let controller = RelayController(toolkitReady: startupError == nil)
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
        #endif
        _relay = State(initialValue: controller)
    }

    var body: some Scene {
        WindowGroup {
            ContentView(relay: relay)
                .onOpenURL { url in
                    relay.handleCallback(url)
                }
        }
    }
}
