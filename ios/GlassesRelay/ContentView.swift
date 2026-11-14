import SwiftUI

struct ContentView: View {
    @Bindable var relay: RelayController
    let lens: LensController
    let hub: GlassesSessionHub

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
                    Toggle("Use mock glasses", isOn: $relay.useMockGlasses)
                        .disabled(relay.isRunning || lens.isOn)
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
                Section {
                    Toggle("Lens card", isOn: Binding(get: { lens.isOn }, set: { lens.setOn($0) }))
                        .disabled(lens.blocker != nil && !lens.isOn)
                    NavigationLink("Lens preview") {
                        LensPreviewView(lens: lens, hub: hub)
                    }
                    Text(lens.blocker ?? lens.statusLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("lensStatus")
                } header: {
                    Text("Lens")
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
