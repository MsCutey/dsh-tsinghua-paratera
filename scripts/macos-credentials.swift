import AppKit
import Security
import CryptoKit

// One item per macOS user; its name is visible in Keychain Access.
let defaultHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dsh").standardizedFileURL.path
let configuredHome = ProcessInfo.processInfo.environment["DSH_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0).standardizedFileURL.path } ?? defaultHome
let namespace = configuredHome == defaultHome ? "" : "." + SHA256.hash(data: Data(configuredHome.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "cn.edu.tsinghua.dsh-tsinghua-paratera" + namespace,
    kSecAttrAccount as String: "easycompute",
]

func readCredentials() {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    // A locked keychain or changed code identity requires the user to open the
    // store dialog again. Background renewal must never show an auth prompt.
    lookup[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    var result: CFTypeRef?
    guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data else { exit(1) }
    FileHandle.standardOutput.write(data)
}

func credentialStatus() {
    var lookup = query
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    lookup[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    // No return-data/attributes flags: only test whether a matching item exists.
    let saved = SecItemCopyMatching(lookup as CFDictionary, nil) == errSecSuccess
    print(saved ? "{\"saved\":true}" : "{\"saved\":false}")
}

func storeCredentials() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let alert = NSAlert()
    alert.messageText = "清华算力凭据"
    alert.informativeText = "账号和密码保存在本机 macOS 钥匙串，仅用于清华统一身份认证。取消则不保存。"
    alert.addButton(withTitle: "保存到钥匙串")
    alert.addButton(withTitle: "取消")
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 340, height: 112))
    let userLabel = NSTextField(labelWithString: "账号（学号 / 工作证号）")
    userLabel.frame = NSRect(x: 0, y: 88, width: 340, height: 20)
    let user = NSTextField(frame: NSRect(x: 0, y: 60, width: 340, height: 24))
    let passwordLabel = NSTextField(labelWithString: "密码")
    passwordLabel.frame = NSRect(x: 0, y: 30, width: 340, height: 20)
    let password = NSSecureTextField(frame: NSRect(x: 0, y: 2, width: 340, height: 24))
    [userLabel, user, passwordLabel, password].forEach { view.addSubview($0) }
    user.nextKeyView = password
    password.nextKeyView = user
    alert.accessoryView = view
    alert.window.initialFirstResponder = user
    app.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { exit(2) }
    let username = user.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !username.isEmpty, !password.stringValue.isEmpty else {
        let error = NSAlert()
        error.messageText = "未保存：账号或密码为空"
        error.runModal()
        exit(1)
    }
    guard let data = try? JSONSerialization.data(withJSONObject: ["username": username, "password": password.stringValue]) else { exit(1) }
    password.stringValue = ""
    var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "DSH 清华算力（Paratera）"
        status = SecItemAdd(item as CFDictionary, nil)
    }
    let notice = NSAlert()
    notice.messageText = status == errSecSuccess ? "已保存到本机钥匙串" : "未能保存到钥匙串（\(status)）"
    notice.informativeText = status == errSecSuccess ? "关闭此提示后，DSH 将自动尝试登录。" : "请检查登录钥匙串是否已解锁后重试。"
    notice.runModal()
    if status != errSecSuccess { exit(1) }
}

switch CommandLine.arguments.dropFirst().first {
case "read": readCredentials()
case "status": credentialStatus()
case "store": storeCredentials()
case "--check": print("{\"ok\":true,\"backend\":\"macOS Keychain\"}")
default: exit(2)
}
