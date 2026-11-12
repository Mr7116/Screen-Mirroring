import SwiftUI
import ReplayKit
import Network

@main
struct MirrorSenderApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var code = SharedSettings.code
    @State private var name = SharedSettings.name
    @State private var port = String(SharedSettings.port)

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("Computer"), footer: Text(addressHint)) {
                    TextField("Screen code (shown on the computer)", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.title2.monospaced())
                }
                Section(header: Text("This device")) {
                    TextField("Name", text: $name)
                }
                Section(header: Text("Share the screen"),
                        footer: Text("Tap the round button, choose MirrorDesk Sender, then Start Broadcast. Stop it from the red bar or Control Centre.")) {
                    HStack {
                        Spacer()
                        BroadcastButton().frame(width: 64, height: 64)
                        Spacer()
                    }
                }
                Section(header: Text("Advanced")) {
                    TextField("Port", text: $port).keyboardType(.numberPad)
                }
            }
            .navigationTitle("MirrorDesk Sender")
        }
        .navigationViewStyle(.stack)
        .onAppear { LocalNetworkProbe.poke(code) }
        .onChange(of: code) { SharedSettings.code = $0; LocalNetworkProbe.poke($0) }
        .onChange(of: name) { SharedSettings.name = $0 }
        .onChange(of: port) { SharedSettings.port = Int($0) ?? SharedSettings.defaultPort }
    }

    private var addressHint: String {
        if let ip = ScreenCode.ipAddress(from: code) { return "Sends to \(ip). Keep the iPhone on the same Wi-Fi." }
        return "Type the 4- or 8-character code from the iPhone tab of MirrorDesk."
    }
}

/// iOS only lets the broadcast reach the computer over Wi-Fi after the app itself has asked for
/// Local Network access, so the app makes one short connection to the computer when a code is typed.
enum LocalNetworkProbe {
    private static var current: NWConnection?

    static func poke(_ code: String) {
        guard let ip = ScreenCode.ipAddress(from: code),
              let port = NWEndpoint.Port(rawValue: UInt16(SharedSettings.port)) else { return }
        current?.cancel()
        let conn = NWConnection(host: NWEndpoint.Host(ip), port: port, using: .tcp)
        current = conn
        conn.stateUpdateHandler = { state in
            if case .ready = state { conn.cancel() }
        }
        conn.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { conn.cancel() }
    }
}

/// Apple's own start/stop button for screen broadcasts, pointed at our extension.
struct BroadcastButton: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        picker.preferredExtension = (Bundle.main.bundleIdentifier ?? "") + ".Broadcast"
        picker.showsMicrophoneButton = false
        return picker
    }
    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
