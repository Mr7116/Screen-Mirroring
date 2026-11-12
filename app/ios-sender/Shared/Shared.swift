import Foundation

/// Settings shared by the app and the broadcast extension (they talk through an App Group).
enum SharedSettings {
    /// Must match the app group in project.yml.
    static let appGroup = "group.com.example.mirrordesk"
    /// MirrorDesk's iPhone receiver listens on the Wi-Fi share port + 1.
    static let defaultPort = 15487

    private static var store: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }

    static var code: String {
        get { store.string(forKey: "code") ?? "" }
        set { store.set(newValue.uppercased(), forKey: "code") }
    }
    static var name: String {
        get { store.string(forKey: "name") ?? "iPhone" }
        set { store.set(newValue, forKey: "name") }
    }
    static var port: Int {
        get { let p = store.integer(forKey: "port"); return p > 0 ? p : defaultPort }
        set { store.set(newValue, forKey: "port") }
    }
}

/// The computer's screen code is its address written in hex, the same rule as the original:
/// 4 digits = 192.168.x.y, 8 digits = all four parts.
enum ScreenCode {
    static func ipAddress(from code: String) -> String? {
        let c = code.trimmingCharacters(in: .whitespaces)
        guard c.count == 4 || c.count == 8, c.allSatisfy({ $0.isHexDigit }) else { return nil }
        var parts: [Int] = []
        var i = c.startIndex
        while i < c.endIndex {
            let j = c.index(i, offsetBy: 2)
            parts.append(Int(c[i..<j], radix: 16) ?? 0)
            i = j
        }
        return parts.count == 2 ? "192.168.\(parts[0]).\(parts[1])" : parts.map(String.init).joined(separator: ".")
    }
}
