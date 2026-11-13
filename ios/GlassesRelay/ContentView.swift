import SwiftUI

struct ContentView: View {
    @Bindable var relay: RelayController

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("192.168.x.x:8800", text: $relay.address)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .disabled(relay.isRunning)
                        .accessibilityLabel("Server address")
                }
                Section("Source") {
                    Picker("Source", selection: $relay.source) {
                        ForEach(SourceKind.allCases) { kind in
                            Text(kind.title).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(relay.isRunning)
                    #if DEBUG
                    if relay.source == .glasses {
                        Toggle("Use mock glasses", isOn: $relay.useMockGlasses)
                            .disabled(relay.isRunning)
                    }
                    #endif
                }
                Section {
                    Button("Connect") {
                        relay.connect()
                    }
                    .disabled(!relay.canConnect)
                    Button("Stop", role: .destructive) {
                        relay.stop()
                    }
                    .disabled(!relay.isRunning)
                }
                Section("Status") {
                    Text(relay.statusLine)
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("status")
                }
            }
            .navigationTitle("GlassesRelay")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
