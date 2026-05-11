import AppKit
import Darwin
import Foundation

func heartbeatStateRoot() -> URL {
    ProcessInfo.processInfo.environment["CODEX_HEARTBEAT_HOME"]
        .map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex-heartbeat")
}

final class SingleInstanceLock {
    private var fd: Int32 = -1
    private let lockURL: URL

    init() {
        lockURL = heartbeatStateRoot().appendingPathComponent("menu.lock")
    }

    func acquire() -> Bool {
        do {
            try FileManager.default.createDirectory(at: lockURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            return false
        }

        fd = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        if fd < 0 {
            return false
        }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            fd = -1
            return false
        }

        ftruncate(fd, 0)
        let pid = "\(getpid())\n"
        _ = pid.withCString { write(fd, $0, strlen($0)) }
        return true
    }

    deinit {
        if fd >= 0 {
            flock(fd, LOCK_UN)
            close(fd)
        }
    }
}

struct HeartbeatStatus: Decodable {
    let stateRoot: String
    let server: ServerStatus
    let sessions: [SessionStatus]
}

struct ServerStatus: Decodable {
    let name: String
    let url: String?
    let pid: Int?
    let running: Bool
    let logFile: String?
}

struct SessionStatus: Decodable {
    let name: String
    let status: String
    let serverName: String?
    let url: String
    let cwd: String
    let threadId: String?
    let threadPinned: Bool?
    let intervalSeconds: Double
    let pid: Int?
    let running: Bool?
    let statusDetail: String?
    let logFile: String?
    let lastHeartbeatAt: String?
    let message: String?
}

struct MenuPreferences: Codable {
    var serverName: String = "default"
    var serverUrl: String = "ws://127.0.0.1:18654"
    var heartbeatIntervalSeconds: Int = 1800
    var heartbeatMessage: String = "Heartbeat check: Are we done? If complete, report completion. If blocked, ask exactly what input is needed. If not blocked and no user input is needed, continue the next safe, coherent step."
    var heartbeatThread: String = ""
    var codexArgs: String = "--yolo"
    var keepHeartbeat: Bool = false

    enum CodingKeys: String, CodingKey {
        case serverName
        case serverUrl
        case heartbeatIntervalSeconds
        case heartbeatMessage
        case heartbeatThread
        case codexArgs
        case keepHeartbeat
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serverName = try container.decodeIfPresent(String.self, forKey: .serverName) ?? serverName
        serverUrl = try container.decodeIfPresent(String.self, forKey: .serverUrl) ?? serverUrl
        heartbeatIntervalSeconds = try container.decodeIfPresent(Int.self, forKey: .heartbeatIntervalSeconds) ?? heartbeatIntervalSeconds
        heartbeatMessage = try container.decodeIfPresent(String.self, forKey: .heartbeatMessage) ?? heartbeatMessage
        heartbeatThread = try container.decodeIfPresent(String.self, forKey: .heartbeatThread) ?? heartbeatThread
        codexArgs = try container.decodeIfPresent(String.self, forKey: .codexArgs) ?? codexArgs
        keepHeartbeat = try container.decodeIfPresent(Bool.self, forKey: .keepHeartbeat) ?? keepHeartbeat
    }
}

func sessionStartArgs(_ session: SessionStatus, intervalSeconds: Int? = nil) -> [String] {
    var args = [
        "session", "start",
        "--name", session.name,
        "--cwd", session.cwd,
        "--interval", String(intervalSeconds ?? Int(session.intervalSeconds)),
    ]
    if let serverName = session.serverName {
        args += ["--server", serverName]
    }
    if !session.url.isEmpty {
        args += ["--url", session.url]
    }
    if let threadId = session.threadId, !threadId.isEmpty {
        if session.threadPinned == true {
            args += ["--thread", threadId]
        } else {
            args += ["--initial-thread", threadId]
        }
    }
    if let message = session.message, !message.isEmpty {
        args += ["--message", message]
    }
    return args
}

func serverStartArgs(_ preferences: MenuPreferences) -> [String] {
    ["server", "start", "--name", preferences.serverName, "--url", preferences.serverUrl]
}

func serverStopArgs(_ preferences: MenuPreferences) -> [String] {
    ["server", "stop", "--name", preferences.serverName]
}

func formatInterval(_ seconds: Double) -> String {
    let value = Int(seconds)
    if value % 3600 == 0 {
        return "\(value / 3600)h"
    }
    if value % 60 == 0 {
        return "\(value / 60)m"
    }
    return "\(value)s"
}

final class PreferencesStore {
    private(set) var preferences: MenuPreferences
    let preferencesURL: URL

    init() {
        preferencesURL = heartbeatStateRoot().appendingPathComponent("preferences.json")
        preferences = (try? Self.load(from: preferencesURL)) ?? MenuPreferences()
    }

    func update(_ block: (inout MenuPreferences) -> Void) throws {
        block(&preferences)
        try save()
    }

    func save() throws {
        try FileManager.default.createDirectory(at: preferencesURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(preferences)
        try data.write(to: preferencesURL, options: .atomic)
    }

    private static func load(from url: URL) throws -> MenuPreferences {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(MenuPreferences.self, from: data)
    }
}

final class IntervalAction: NSObject {
    let session: SessionStatus
    let seconds: Int

    init(session: SessionStatus, seconds: Int) {
        self.session = session
        self.seconds = seconds
    }
}

final class SessionIntervalPopup: NSPopUpButton {
    var sessionName: String = ""
}

final class CommandRunner {
    let cliPath: String

    init(cliPath: String = CommandRunner.discoverCliPath()) {
        self.cliPath = cliPath
    }

    static func discoverCliPath() -> String {
        if let value = ProcessInfo.processInfo.environment["CODEX_HEARTBEAT_CLI"], !value.isEmpty {
            return value
        }

        if let resourcePath = Bundle.main.resourcePath {
            let bundled = URL(fileURLWithPath: resourcePath)
                .appendingPathComponent("codex-heartbeat/bin/codex-heartbeat.mjs")
            if FileManager.default.fileExists(atPath: bundled.path) {
                return bundled.path
            }
        }

        let executable = URL(fileURLWithPath: CommandLine.arguments[0])
        let repoCandidate = executable.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("bin/codex-heartbeat.mjs")
        if FileManager.default.fileExists(atPath: repoCandidate.path) {
            return repoCandidate.path
        }

        return "codex-heartbeat"
    }

    func run(_ args: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        if cliPath.hasSuffix(".mjs") {
            process.arguments = ["node", cliPath] + args
        } else {
            process.arguments = [cliPath] + args
        }
        process.environment = CommandRunner.processEnvironment()

        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error
        try process.run()
        process.waitUntilExit()

        let outputText = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errorText = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 {
            throw NSError(
                domain: "CodexHeartbeatMenu",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: errorText.isEmpty ? outputText : errorText]
            )
        }
        return outputText
    }

    static func processEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let defaultPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let path = environment["PATH"], !path.isEmpty {
            environment["PATH"] = "\(defaultPath):\(path)"
        } else {
            environment["PATH"] = defaultPath
        }
        return environment
    }

    func status() throws -> HeartbeatStatus {
        let text = try run(["status", "--json"])
        guard let data = text.data(using: .utf8) else {
            throw NSError(domain: "CodexHeartbeatMenu", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid UTF-8 from CLI"])
        }
        return try JSONDecoder().decode(HeartbeatStatus.self, from: data)
    }
}

final class LaunchAgentManager {
    static let label = "com.codex-heartbeat.menu"

    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static var isInstalled: Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    static func install(cliPath: String, loadNow: Bool = true) throws {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).path
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(label)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(escapePlist(executable))</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>EnvironmentVariables</key>
          <dict>
            <key>CODEX_HEARTBEAT_CLI</key>
            <string>\(escapePlist(cliPath))</string>
            <key>PATH</key>
            <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
          </dict>
        </dict>
        </plist>
        """

        try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try plist.write(to: plistURL, atomically: true, encoding: .utf8)
        _ = try? runLaunchctl(["bootout", guiDomain(), plistURL.path])
        if loadNow {
            _ = try runLaunchctl(["bootstrap", guiDomain(), plistURL.path])
        }
    }

    static func uninstall() throws {
        _ = try? runLaunchctl(["bootout", guiDomain(), plistURL.path])
        if FileManager.default.fileExists(atPath: plistURL.path) {
            try FileManager.default.removeItem(at: plistURL)
        }
    }

    private static func guiDomain() -> String {
        "gui/\(getuid())"
    }

    private static func runLaunchctl(_ args: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = args
        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error
        try process.run()
        process.waitUntilExit()
        let outputText = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errorText = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 {
            throw NSError(
                domain: "CodexHeartbeatMenu",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: errorText.isEmpty ? outputText : errorText]
            )
        }
        return outputText
    }

    private static func escapePlist(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
}

final class SettingsWindowController: NSWindowController {
    private let preferencesStore: PreferencesStore
    private let onSave: () -> Void
    private let serverNameField = NSTextField()
    private let serverUrlField = NSTextField()
    private let intervalField = NSTextField()
    private let heartbeatMessageTextView = NSTextView()
    private let heartbeatThreadField = NSTextField()
    private let codexArgsField = NSTextField()
    private let keepHeartbeatCheckbox = NSButton(checkboxWithTitle: "Keep heartbeat running after Codex exits", target: nil, action: nil)

    init(preferencesStore: PreferencesStore, onSave: @escaping () -> Void) {
        self.preferencesStore = preferencesStore
        self.onSave = onSave

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 460),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Codex Heartbeat Settings"
        window.isReleasedWhenClosed = false
        window.center()

        super.init(window: window)
        buildContent()
        loadValues()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func buildContent() {
        guard let window else { return }
        window.setContentSize(NSSize(width: 620, height: 460))
        let content = NSView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 620, height: 460))
        window.contentView = content

        addRow(to: content, label: "Server name", field: serverNameField, y: 400)
        addRow(to: content, label: "Server URL", field: serverUrlField, y: 360)
        addRow(to: content, label: "Interval seconds", field: intervalField, y: 320)
        addRow(to: content, label: "Heartbeat thread", field: heartbeatThreadField, y: 280)
        addTextArea(to: content, label: "Heartbeat text", textView: heartbeatMessageTextView, y: 145, height: 105)
        addRow(to: content, label: "Codex args", field: codexArgsField, y: 105)

        keepHeartbeatCheckbox.frame = NSRect(x: 150, y: 68, width: 430, height: 22)
        content.addSubview(keepHeartbeatCheckbox)

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancel.frame = NSRect(x: 414, y: 24, width: 86, height: 30)
        content.addSubview(cancel)

        let save = NSButton(title: "Save", target: self, action: #selector(save))
        save.keyEquivalent = "s"
        save.keyEquivalentModifierMask = .command
        save.frame = NSRect(x: 510, y: 24, width: 86, height: 30)
        content.addSubview(save)
    }

    private func addRow(to content: NSView, label: String, field: NSTextField, y: CGFloat) {
        let labelView = NSTextField(labelWithString: label)
        labelView.alignment = .right
        labelView.frame = NSRect(x: 24, y: y + 4, width: 110, height: 18)
        content.addSubview(labelView)

        field.frame = NSRect(x: 150, y: y, width: 430, height: 24)
        content.addSubview(field)
    }

    private func addTextArea(to content: NSView, label: String, textView: NSTextView, y: CGFloat, height: CGFloat) {
        let labelView = NSTextField(labelWithString: label)
        labelView.alignment = .right
        labelView.frame = NSRect(x: 24, y: y + height - 22, width: 110, height: 18)
        content.addSubview(labelView)

        textView.font = NSFont.systemFont(ofSize: 13)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.textContainerInset = NSSize(width: 5, height: 5)
        textView.autoresizingMask = [.width]

        let scroll = NSScrollView(frame: NSRect(x: 150, y: y, width: 430, height: height))
        scroll.borderType = .bezelBorder
        scroll.hasVerticalScroller = true
        scroll.autoresizingMask = [.width]
        scroll.documentView = textView
        content.addSubview(scroll)
    }

    private func loadValues() {
        let prefs = preferencesStore.preferences
        serverNameField.stringValue = prefs.serverName
        serverUrlField.stringValue = prefs.serverUrl
        intervalField.stringValue = String(prefs.heartbeatIntervalSeconds)
        heartbeatMessageTextView.string = prefs.heartbeatMessage
        heartbeatThreadField.stringValue = prefs.heartbeatThread
        codexArgsField.stringValue = prefs.codexArgs
        keepHeartbeatCheckbox.state = prefs.keepHeartbeat ? .on : .off
    }

    @objc private func cancel() {
        close()
    }

    @objc private func save() {
        let serverName = serverNameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let serverUrl = serverUrlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let heartbeatMessage = heartbeatMessageTextView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        let heartbeatThread = heartbeatThreadField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let codexArgs = codexArgsField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let interval = Int(intervalField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)), interval > 0 else {
            showError("Interval must be a positive number of seconds.")
            return
        }
        guard !serverName.isEmpty else {
            showError("Server name is required.")
            return
        }
        guard serverName.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil else {
            showError("Server name may only contain letters, numbers, dot, underscore, and dash.")
            return
        }
        guard !serverUrl.isEmpty else {
            showError("Server URL is required.")
            return
        }
        guard !heartbeatMessage.isEmpty else {
            showError("Heartbeat text is required.")
            return
        }

        do {
            try preferencesStore.update {
                $0.serverName = serverName
                $0.serverUrl = serverUrl
                $0.heartbeatIntervalSeconds = interval
                $0.heartbeatMessage = heartbeatMessage
                $0.heartbeatThread = heartbeatThread
                $0.codexArgs = codexArgs
                $0.keepHeartbeat = keepHeartbeatCheckbox.state == .on
            }
            onSave()
            close()
        } catch {
            showError(error.localizedDescription)
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Settings could not be saved"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
}

final class DashboardWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    private let runner: CommandRunner
    private let preferencesStore: PreferencesStore
    private let onStartCodex: () -> Void
    private let onChanged: () -> Void
    private var status: HeartbeatStatus?
    private var sessions: [SessionStatus] = []
    private let serverLabel = NSTextField(labelWithString: "Server: unknown")
    private let urlLabel = NSTextField(labelWithString: "URL: unknown")
    private let errorLabel = NSTextField(labelWithString: "")
    private let tableView = NSTableView()
    private let defaultIntervalPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let heartbeatMessageTextView = NSTextView()
    private let heartbeatThreadField = NSTextField()
    private let keepHeartbeatCheckbox = NSButton(checkboxWithTitle: "Keep heartbeat running after Codex closes", target: nil, action: nil)
    private let advancedDisclosure = NSButton(checkboxWithTitle: "Show advanced settings", target: nil, action: nil)
    private let serverNameField = NSTextField()
    private let serverUrlField = NSTextField()
    private let codexArgsField = NSTextField()
    private let settingsStatusLabel = NSTextField(labelWithString: "")
    private var advancedSettingViews: [NSView] = []
    private let intervalChoices = [300, 900, 1800, 3600]
    private let settingsColumnX: CGFloat = 680

    init(runner: CommandRunner, preferencesStore: PreferencesStore, onStartCodex: @escaping () -> Void, onChanged: @escaping () -> Void) {
        self.runner = runner
        self.preferencesStore = preferencesStore
        self.onStartCodex = onStartCodex
        self.onChanged = onChanged

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 640),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Codex Heartbeat"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 920, height: 560)
        window.center()

        super.init(window: window)
        buildContent()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(status: HeartbeatStatus?, lastError: String?) {
        let selectedName = selectedSession()?.name
        self.status = status
        self.sessions = status?.sessions ?? []
        if let status {
            serverLabel.stringValue = "Server: \(status.server.running ? "running" : "stopped")"
            urlLabel.stringValue = "URL: \(status.server.url ?? "none")"
        } else {
            serverLabel.stringValue = "Server: unknown"
            urlLabel.stringValue = "URL: unknown"
        }
        errorLabel.stringValue = lastError ?? ""
        tableView.reloadData()
        if let selectedName, let row = sessions.firstIndex(where: { $0.name == selectedName }) {
            tableView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        }
    }

    private func buildContent() {
        guard let window else { return }
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 1040, height: 640))
        content.autoresizingMask = [.width, .height]
        window.contentView = content

        let title = NSTextField(labelWithString: "Codex Heartbeat")
        title.frame = NSRect(x: 24, y: 596, width: 240, height: 24)
        title.autoresizingMask = [.minYMargin]
        title.font = NSFont.boldSystemFont(ofSize: 18)
        content.addSubview(title)

        let subtitle = NSTextField(labelWithString: "Launch Codex with heartbeat, monitor sessions, and adjust the settings most users need.")
        subtitle.frame = NSRect(x: 24, y: 572, width: 620, height: 18)
        subtitle.autoresizingMask = [.width, .minYMargin]
        subtitle.textColor = .secondaryLabelColor
        content.addSubview(subtitle)

        serverLabel.frame = NSRect(x: 24, y: 536, width: 220, height: 18)
        serverLabel.autoresizingMask = [.minYMargin]
        serverLabel.font = NSFont.boldSystemFont(ofSize: 13)
        content.addSubview(serverLabel)

        urlLabel.frame = NSRect(x: 24, y: 514, width: 520, height: 18)
        urlLabel.autoresizingMask = [.width, .minYMargin]
        urlLabel.textColor = .secondaryLabelColor
        content.addSubview(urlLabel)

        addButton(to: content, title: "Start Codex", action: #selector(startCodex), frame: NSRect(x: 24, y: 468, width: 116, height: 32)).autoresizingMask = [.minYMargin]
        addButton(to: content, title: "Start Server", action: #selector(startServer), frame: NSRect(x: 152, y: 468, width: 112, height: 32)).autoresizingMask = [.minYMargin]
        addButton(to: content, title: "Stop Server", action: #selector(stopServer), frame: NSRect(x: 276, y: 468, width: 112, height: 32)).autoresizingMask = [.minYMargin]
        addButton(to: content, title: "Refresh", action: #selector(refresh), frame: NSRect(x: 400, y: 468, width: 86, height: 32)).autoresizingMask = [.minYMargin]

        let sessionsTitle = NSTextField(labelWithString: "Sessions")
        sessionsTitle.frame = NSRect(x: 24, y: 432, width: 180, height: 20)
        sessionsTitle.autoresizingMask = [.minYMargin]
        sessionsTitle.font = NSFont.boldSystemFont(ofSize: 14)
        content.addSubview(sessionsTitle)

        let scroll = NSScrollView(frame: NSRect(x: 24, y: 118, width: 620, height: 308))
        scroll.autoresizingMask = [.width, .height]
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.documentView = tableView
        content.addSubview(scroll)

        addColumn("name", title: "Session", width: 170)
        addColumn("status", title: "Status", width: 80)
        addColumn("cwd", title: "Project", width: 190)
        addColumn("interval", title: "Interval", width: 70)
        addColumn("last", title: "Last Heartbeat", width: 110)
        tableView.delegate = self
        tableView.dataSource = self
        tableView.usesAlternatingRowBackgroundColors = true
        tableView.allowsMultipleSelection = false
        tableView.headerView = NSTableHeaderView()
        tableView.cornerView = NSView()

        addButton(to: content, title: "Start", action: #selector(startSession), frame: NSRect(x: 24, y: 74, width: 72, height: 30))
        addButton(to: content, title: "Stop", action: #selector(stopSession), frame: NSRect(x: 104, y: 74, width: 72, height: 30))
        addButton(to: content, title: "Restart", action: #selector(restartSession), frame: NSRect(x: 184, y: 74, width: 82, height: 30))
        addButton(to: content, title: "Remove", action: #selector(removeSession), frame: NSRect(x: 274, y: 74, width: 82, height: 30))
        addButton(to: content, title: "Open Log", action: #selector(openLog), frame: NSRect(x: 364, y: 74, width: 86, height: 30))

        buildSettingsPanel(content)

        errorLabel.frame = NSRect(x: 24, y: 24, width: 990, height: 18)
        errorLabel.autoresizingMask = [.width, .maxYMargin]
        errorLabel.textColor = .systemRed
        content.addSubview(errorLabel)
        loadSettings()
    }

    private func buildSettingsPanel(_ content: NSView) {
        let x = settingsColumnX
        let title = NSTextField(labelWithString: "Settings")
        title.frame = NSRect(x: x, y: 536, width: 260, height: 22)
        title.autoresizingMask = [.minXMargin, .minYMargin]
        title.font = NSFont.boldSystemFont(ofSize: 15)
        content.addSubview(title)

        let note = NSTextField(wrappingLabelWithString: "These defaults are used when starting new Codex sessions from the menu. Running sessions can use their own interval.")
        note.frame = NSRect(x: x, y: 492, width: 320, height: 38)
        note.autoresizingMask = [.minXMargin, .minYMargin]
        note.textColor = .secondaryLabelColor
        content.addSubview(note)

        addSettingsLabel("Default interval", to: content, x: x, y: 454)
        defaultIntervalPopup.frame = NSRect(x: x, y: 426, width: 160, height: 26)
        defaultIntervalPopup.autoresizingMask = [.minXMargin, .minYMargin]
        defaultIntervalPopup.addItems(withTitles: ["5m", "15m", "30m", "1h"])
        content.addSubview(defaultIntervalPopup)

        addSettingsLabel("Heartbeat message", to: content, x: x, y: 386)
        heartbeatMessageTextView.font = NSFont.systemFont(ofSize: 13)
        heartbeatMessageTextView.isRichText = false
        heartbeatMessageTextView.allowsUndo = true
        heartbeatMessageTextView.textContainerInset = NSSize(width: 6, height: 6)
        let messageScroll = NSScrollView(frame: NSRect(x: x, y: 250, width: 320, height: 130))
        messageScroll.autoresizingMask = [.minXMargin, .minYMargin]
        messageScroll.borderType = .bezelBorder
        messageScroll.hasVerticalScroller = true
        messageScroll.documentView = heartbeatMessageTextView
        content.addSubview(messageScroll)

        keepHeartbeatCheckbox.frame = NSRect(x: x, y: 216, width: 320, height: 22)
        keepHeartbeatCheckbox.autoresizingMask = [.minXMargin, .minYMargin]
        content.addSubview(keepHeartbeatCheckbox)

        advancedDisclosure.frame = NSRect(x: x, y: 180, width: 220, height: 22)
        advancedDisclosure.autoresizingMask = [.minXMargin, .minYMargin]
        advancedDisclosure.target = self
        advancedDisclosure.action = #selector(toggleAdvancedSettings)
        content.addSubview(advancedDisclosure)

        addAdvancedRow("Preferred thread", field: heartbeatThreadField, to: content, x: x, y: 140)
        addAdvancedRow("Server name", field: serverNameField, to: content, x: x, y: 104)
        addAdvancedRow("Server URL", field: serverUrlField, to: content, x: x, y: 68)
        addAdvancedRow("Codex args", field: codexArgsField, to: content, x: x, y: 32)

        let save = NSButton(title: "Save Settings", target: self, action: #selector(saveSettings))
        save.frame = NSRect(x: 888, y: 178, width: 112, height: 30)
        save.autoresizingMask = [.minXMargin, .minYMargin]
        content.addSubview(save)

        settingsStatusLabel.frame = NSRect(x: x, y: 8, width: 320, height: 18)
        settingsStatusLabel.autoresizingMask = [.minXMargin, .minYMargin]
        settingsStatusLabel.textColor = .secondaryLabelColor
        content.addSubview(settingsStatusLabel)

        setAdvancedSettingsVisible(false)
    }

    private func addColumn(_ id: String, title: String, width: CGFloat) {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
        column.title = title
        column.width = width
        tableView.addTableColumn(column)
    }

    @discardableResult
    private func addButton(to content: NSView, title: String, action: Selector, frame: NSRect) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.frame = frame
        content.addSubview(button)
        return button
    }

    private func addSettingsLabel(_ title: String, to content: NSView, x: CGFloat, y: CGFloat) {
        let label = NSTextField(labelWithString: title)
        label.frame = NSRect(x: x, y: y, width: 220, height: 18)
        label.autoresizingMask = [.minXMargin, .minYMargin]
        label.font = NSFont.boldSystemFont(ofSize: 12)
        content.addSubview(label)
    }

    private func addAdvancedRow(_ title: String, field: NSTextField, to content: NSView, x: CGFloat, y: CGFloat) {
        let label = NSTextField(labelWithString: title)
        label.frame = NSRect(x: x, y: y + 22, width: 140, height: 16)
        label.autoresizingMask = [.minXMargin, .minYMargin]
        label.textColor = .secondaryLabelColor
        label.font = NSFont.systemFont(ofSize: 11)
        content.addSubview(label)

        field.frame = NSRect(x: x, y: y, width: 320, height: 22)
        field.autoresizingMask = [.minXMargin, .minYMargin]
        content.addSubview(field)
        advancedSettingViews.append(label)
        advancedSettingViews.append(field)
    }

    private func setAdvancedSettingsVisible(_ visible: Bool) {
        for view in advancedSettingViews {
            view.isHidden = !visible
        }
    }

    private func loadSettings() {
        let prefs = preferencesStore.preferences
        if let index = intervalChoices.firstIndex(of: prefs.heartbeatIntervalSeconds) {
            defaultIntervalPopup.selectItem(at: index)
        } else {
            defaultIntervalPopup.selectItem(withTitle: "30m")
        }
        heartbeatMessageTextView.string = prefs.heartbeatMessage
        heartbeatThreadField.stringValue = prefs.heartbeatThread
        keepHeartbeatCheckbox.state = prefs.keepHeartbeat ? .on : .off
        serverNameField.stringValue = prefs.serverName
        serverUrlField.stringValue = prefs.serverUrl
        codexArgsField.stringValue = prefs.codexArgs
        settingsStatusLabel.stringValue = ""
    }

    @objc private func toggleAdvancedSettings() {
        setAdvancedSettingsVisible(advancedDisclosure.state == .on)
    }

    @objc private func saveSettings() {
        let intervalIndex = defaultIntervalPopup.indexOfSelectedItem
        let interval = intervalIndex >= 0 && intervalIndex < intervalChoices.count ? intervalChoices[intervalIndex] : 1800
        let heartbeatMessage = heartbeatMessageTextView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        let heartbeatThread = heartbeatThreadField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let serverName = serverNameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let serverUrl = serverUrlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let codexArgs = codexArgsField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !heartbeatMessage.isEmpty else {
            settingsStatusLabel.stringValue = "Heartbeat message is required."
            settingsStatusLabel.textColor = .systemRed
            return
        }
        guard !serverName.isEmpty, serverName.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil else {
            settingsStatusLabel.stringValue = "Advanced server name is invalid."
            settingsStatusLabel.textColor = .systemRed
            return
        }
        guard !serverUrl.isEmpty else {
            settingsStatusLabel.stringValue = "Advanced server URL is required."
            settingsStatusLabel.textColor = .systemRed
            return
        }

        do {
            try preferencesStore.update {
                $0.heartbeatIntervalSeconds = interval
                $0.heartbeatMessage = heartbeatMessage
                $0.heartbeatThread = heartbeatThread
                $0.keepHeartbeat = keepHeartbeatCheckbox.state == .on
                $0.serverName = serverName
                $0.serverUrl = serverUrl
                $0.codexArgs = codexArgs
            }
            settingsStatusLabel.stringValue = "Settings saved."
            settingsStatusLabel.textColor = .secondaryLabelColor
            onChanged()
        } catch {
            settingsStatusLabel.stringValue = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            settingsStatusLabel.textColor = .systemRed
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int {
        sessions.count
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        28
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < sessions.count, let id = tableColumn?.identifier.rawValue else { return nil }
        let session = sessions[row]
        let width = tableColumn?.width ?? 80
        if id == "interval" {
            let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 28))
            let popup = SessionIntervalPopup(frame: NSRect(x: 0, y: 2, width: width, height: 24), pullsDown: false)
            popup.bezelStyle = .texturedRounded
            popup.isBordered = false
            popup.addItems(withTitles: intervalChoices.map { formatInterval(Double($0)) })
            if let index = intervalChoices.firstIndex(of: Int(session.intervalSeconds)) {
                popup.selectItem(at: index)
            }
            popup.target = self
            popup.action = #selector(setIntervalFromCell(_:))
            popup.sessionName = session.name
            container.addSubview(popup)
            return container
        }

        let value: String
        switch id {
        case "name":
            value = session.name
        case "status":
            value = session.status
        case "cwd":
            value = session.cwd
        case "interval":
            value = formatInterval(session.intervalSeconds)
        case "target":
            value = session.threadPinned == true ? "pinned" : "latest cwd"
        case "last":
            value = session.lastHeartbeatAt ?? ""
        default:
            value = ""
        }

        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 28))
        container.identifier = tableColumn!.identifier
        let cell = NSTextField(labelWithString: "")
        cell.frame = NSRect(x: 0, y: 5, width: width, height: 18)
        cell.font = NSFont.systemFont(ofSize: 13)
        cell.lineBreakMode = .byTruncatingMiddle
        cell.stringValue = value
        container.addSubview(cell)
        return container
    }

    private func selectedSession() -> SessionStatus? {
        let row = tableView.selectedRow
        guard row >= 0, row < sessions.count else { return nil }
        return sessions[row]
    }

    private func runCommand(_ args: [String]) {
        DispatchQueue.global(qos: .utility).async {
            do {
                _ = try self.runner.run(args)
                DispatchQueue.main.async { self.onChanged() }
            } catch {
                DispatchQueue.main.async {
                    self.errorLabel.stringValue = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
        }
    }

    private func restart(_ session: SessionStatus, intervalSeconds: Int? = nil) {
        let startArgs = sessionStartArgs(session, intervalSeconds: intervalSeconds)
        DispatchQueue.global(qos: .utility).async {
            do {
                _ = try self.runner.run(["session", "stop", "--name", session.name])
                _ = try self.runner.run(startArgs)
                DispatchQueue.main.async { self.onChanged() }
            } catch {
                DispatchQueue.main.async {
                    self.errorLabel.stringValue = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
        }
    }

    @objc private func refresh() {
        onChanged()
    }

    @objc private func startCodex() {
        onStartCodex()
    }

    @objc private func startServer() {
        runCommand(serverStartArgs(preferencesStore.preferences))
    }

    @objc private func stopServer() {
        runCommand(serverStopArgs(preferencesStore.preferences))
    }

    @objc private func startSession() {
        guard let session = selectedSession() else { return }
        runCommand(sessionStartArgs(session))
    }

    @objc private func stopSession() {
        guard let session = selectedSession() else { return }
        runCommand(["session", "stop", "--name", session.name])
    }

    @objc private func restartSession() {
        guard let session = selectedSession() else { return }
        restart(session)
    }

    @objc private func removeSession() {
        guard let session = selectedSession() else { return }
        let alert = NSAlert()
        alert.messageText = "Remove \(session.name)?"
        alert.informativeText = "This deletes the saved heartbeat session state and logs from the heartbeat state directory."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        runCommand(["session", "remove", "--name", session.name])
    }

    @objc private func openLog() {
        guard let logFile = selectedSession()?.logFile else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: logFile))
    }

    @objc private func setIntervalFromCell(_ sender: NSPopUpButton) {
        guard
            let popup = sender as? SessionIntervalPopup,
            let session = sessions.first(where: { $0.name == popup.sessionName })
        else { return }
        let index = sender.indexOfSelectedItem
        guard index >= 0, index < intervalChoices.count else { return }
        restart(session, intervalSeconds: intervalChoices[index])
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let runner = CommandRunner()
    private let preferencesStore = PreferencesStore()
    private let singleInstanceLock = SingleInstanceLock()
    private var latestStatus: HeartbeatStatus?
    private var refreshTimer: Timer?
    private var lastError: String?
    private var settingsWindowController: SettingsWindowController?
    private var dashboardWindowController: DashboardWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard singleInstanceLock.acquire() else {
            NSApp.terminate(nil)
            return
        }

        NSApp.setActivationPolicy(.accessory)
        configureStatusButton()
        refresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    private func configureStatusButton() {
        guard let button = statusItem.button else { return }
        if let image = NSImage(named: "StatusIcon") {
            image.size = NSSize(width: 18, height: 18)
            button.image = image
            button.imagePosition = .imageLeading
            button.title = "..."
        } else {
            button.title = "HB..."
        }
    }

    private func refresh() {
        DispatchQueue.global(qos: .utility).async {
            do {
                let status = try self.runner.status()
                DispatchQueue.main.async {
                    self.latestStatus = status
                    self.lastError = nil
                    self.dashboardWindowController?.update(status: status, lastError: nil)
                    self.renderMenu()
                }
            } catch {
                DispatchQueue.main.async {
                    self.lastError = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.dashboardWindowController?.update(status: self.latestStatus, lastError: self.lastError)
                    self.renderMenu()
                }
            }
        }
    }

    private func runCommand(_ args: [String]) {
        DispatchQueue.global(qos: .utility).async {
            do {
                _ = try self.runner.run(args)
                DispatchQueue.main.async { self.refresh() }
            } catch {
                DispatchQueue.main.async {
                    self.lastError = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.renderMenu()
                }
            }
        }
    }

    private func renderMenu() {
        let menu = NSMenu()

        if let status = latestStatus {
            statusItem.button?.title = status.server.running ? "on" : "off"
            addDisabled(menu, "Codex Heartbeat")
            addDisabled(menu, "State: \(status.stateRoot)")
            menu.addItem(NSMenuItem.separator())

            addAction(menu, "Start Codex with Heartbeat...", #selector(startCodexWithHeartbeat))
            menu.addItem(NSMenuItem.separator())

            addDisabled(menu, "Server: \(status.server.running ? "running" : "stopped")")
            addDisabled(menu, "URL: \(status.server.url ?? "none")")
            if status.server.running {
                addAction(menu, "Stop App-Server", #selector(stopServer))
            } else {
                addAction(menu, "Start App-Server", #selector(startServer))
            }

            menu.addItem(NSMenuItem.separator())
            addDisabled(menu, "Sessions")
            if status.sessions.isEmpty {
                addDisabled(menu, "No heartbeat sessions")
            } else {
                for session in status.sessions {
                    menu.addItem(sessionMenuItem(session))
                }
            }
        } else {
            statusItem.button?.title = "?"
            addDisabled(menu, "Codex Heartbeat")
            addDisabled(menu, "Status unavailable")
        }

        if let lastError, !lastError.isEmpty {
            menu.addItem(NSMenuItem.separator())
            addDisabled(menu, "Last error:")
            addDisabled(menu, lastError)
        }

        menu.addItem(NSMenuItem.separator())
        addAction(menu, "Open Control Panel...", #selector(openDashboardWindow))
        addAction(menu, "Open Preferences File", #selector(openPreferencesFile))
        addAction(
            menu,
            LaunchAgentManager.isInstalled ? "Disable Launch at Login" : "Enable Launch at Login",
            LaunchAgentManager.isInstalled ? #selector(disableLaunchAtLogin) : #selector(enableLaunchAtLogin)
        )
        addAction(menu, "Refresh", #selector(refreshAction))
        addAction(menu, "Quit", #selector(quit))
        statusItem.menu = menu
    }

    private func sessionMenuItem(_ session: SessionStatus) -> NSMenuItem {
        let item = NSMenuItem(title: "\(session.name): \(session.status)", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        addDisabled(submenu, "Status: \(session.status)")
        addDisabled(submenu, "Server: \(session.serverName ?? "external")")
        addDisabled(submenu, "CWD: \(session.cwd)")
        addDisabled(submenu, "Interval: \(formatInterval(session.intervalSeconds))")
        addDisabled(submenu, "Target: \(session.threadPinned == true ? "pinned thread" : "latest cwd thread")")
        addDisabled(submenu, "Thread: \(session.threadId ?? "not selected")")
        if let lastHeartbeatAt = session.lastHeartbeatAt {
            addDisabled(submenu, "Last heartbeat: \(lastHeartbeatAt)")
        }
        if let statusDetail = session.statusDetail {
            addDisabled(submenu, statusDetail)
        }

        submenu.addItem(NSMenuItem.separator())
        if session.running == true {
            let restart = NSMenuItem(title: "Restart Heartbeat", action: #selector(restartSession(_:)), keyEquivalent: "")
            restart.target = self
            restart.representedObject = session
            submenu.addItem(restart)

            let stop = NSMenuItem(title: "Stop Heartbeat", action: #selector(stopSession(_:)), keyEquivalent: "")
            stop.target = self
            stop.representedObject = session.name
            submenu.addItem(stop)
        } else {
            let start = NSMenuItem(title: "Start Heartbeat", action: #selector(startSession(_:)), keyEquivalent: "")
            start.target = self
            start.representedObject = session
            submenu.addItem(start)

            let remove = NSMenuItem(title: "Remove Session", action: #selector(removeSession(_:)), keyEquivalent: "")
            remove.target = self
            remove.representedObject = session.name
            submenu.addItem(remove)
        }
        addIntervalMenu(submenu, session: session)

        if let logFile = session.logFile {
            let log = NSMenuItem(title: "Open Log", action: #selector(openLog(_:)), keyEquivalent: "")
            log.target = self
            log.representedObject = logFile
            submenu.addItem(log)
        }

        item.submenu = submenu
        return item
    }

    private func addIntervalMenu(_ menu: NSMenu, session: SessionStatus) {
        let item = NSMenuItem(title: "Set Interval", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for seconds in [300, 900, 1800, 3600] {
            let option = NSMenuItem(title: formatInterval(Double(seconds)), action: #selector(setInterval(_:)), keyEquivalent: "")
            option.target = self
            option.representedObject = IntervalAction(session: session, seconds: seconds)
            submenu.addItem(option)
        }
        item.submenu = submenu
        menu.addItem(item)
    }

    private func addDisabled(_ menu: NSMenu, _ title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        menu.addItem(item)
    }

    private func addAction(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
    }

    private func prompt(title: String, message: String, value: String) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.stringValue = value
        alert.accessoryView = field

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            return nil
        }
        return field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func quoteShell(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    private func wrapperCommand(cwd: String) -> String {
        let prefs = preferencesStore.preferences
        var parts: [String] = []
        if runner.cliPath.hasSuffix(".mjs") {
            parts += ["node", quoteShell(runner.cliPath)]
        } else {
            parts.append(quoteShell(runner.cliPath))
        }
        parts += [
            "codex",
            "--server", quoteShell(prefs.serverName),
            "--url", quoteShell(prefs.serverUrl),
            "--heartbeat-interval", String(prefs.heartbeatIntervalSeconds),
            "--heartbeat-message", quoteShell(prefs.heartbeatMessage),
            "--heartbeat-cwd", quoteShell(cwd),
        ]
        if !prefs.heartbeatThread.isEmpty {
            parts += ["--heartbeat-thread", quoteShell(prefs.heartbeatThread)]
        }
        if prefs.keepHeartbeat {
            parts.append("--keep-heartbeat")
        }
        if !prefs.codexArgs.isEmpty {
            parts.append(prefs.codexArgs)
        }
        return parts.joined(separator: " ")
    }

    private func openTerminal(command: String) throws {
        let script = """
        tell application "Terminal"
          activate
          do script "\(escapeAppleScript(command))"
        end tell
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        let error = Pipe()
        process.standardError = error
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            let errorText = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw NSError(domain: "CodexHeartbeatMenu", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: errorText.isEmpty ? "Failed to open Terminal" : errorText
            ])
        }
    }

    private func escapeAppleScript(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    @objc private func startServer() {
        runCommand(serverStartArgs(preferencesStore.preferences))
    }

    @objc private func stopServer() {
        runCommand(serverStopArgs(preferencesStore.preferences))
    }

    @objc private func stopSession(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        runCommand(["session", "stop", "--name", name])
    }

    @objc private func startSession(_ sender: NSMenuItem) {
        guard let session = sender.representedObject as? SessionStatus else { return }
        runCommand(sessionStartArgs(session))
    }

    @objc private func removeSession(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        runCommand(["session", "remove", "--name", name])
    }

    @objc private func restartSession(_ sender: NSMenuItem) {
        guard let session = sender.representedObject as? SessionStatus else { return }
        DispatchQueue.global(qos: .utility).async {
            do {
                _ = try self.runner.run(["session", "stop", "--name", session.name])
                _ = try self.runner.run(sessionStartArgs(session))
                DispatchQueue.main.async { self.refresh() }
            } catch {
                DispatchQueue.main.async {
                    self.lastError = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.renderMenu()
                }
            }
        }
    }

    @objc private func startCodexWithHeartbeat() {
        let panel = NSOpenPanel()
        panel.title = "Choose a project folder"
        panel.message = "Codex will start in this folder with heartbeat enabled."
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser

        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }

        let cwd = url.path
        let command = "cd \(quoteShell(cwd)); \(wrapperCommand(cwd: cwd))"
        do {
            try openTerminal(command: command)
        } catch {
            lastError = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            renderMenu()
        }
    }

    @objc private func setInterval(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? IntervalAction else { return }
        let startArgs = sessionStartArgs(action.session, intervalSeconds: action.seconds)

        DispatchQueue.global(qos: .utility).async {
            do {
                _ = try self.runner.run(["session", "stop", "--name", action.session.name])
                _ = try self.runner.run(startArgs)
                DispatchQueue.main.async { self.refresh() }
            } catch {
                DispatchQueue.main.async {
                    self.lastError = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.renderMenu()
                }
            }
        }
    }

    @objc private func openLog(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func setDefaultServerName() {
        guard let value = prompt(
            title: "Default Server Name",
            message: "Used by Start Codex with Heartbeat.",
            value: preferencesStore.preferences.serverName
        ), !value.isEmpty else { return }
        do {
            try preferencesStore.update { $0.serverName = value }
            renderMenu()
        } catch {
            lastError = error.localizedDescription
            renderMenu()
        }
    }

    @objc private func setDefaultServerUrl() {
        guard let value = prompt(
            title: "Default Server URL",
            message: "Used when the selected server is not already running.",
            value: preferencesStore.preferences.serverUrl
        ), !value.isEmpty else { return }
        do {
            try preferencesStore.update { $0.serverUrl = value }
            renderMenu()
        } catch {
            lastError = error.localizedDescription
            renderMenu()
        }
    }

    @objc private func setDefaultInterval() {
        guard let value = prompt(
            title: "Default Heartbeat Interval",
            message: "Seconds between heartbeat checks for new Codex sessions.",
            value: String(preferencesStore.preferences.heartbeatIntervalSeconds)
        ) else { return }
        guard let seconds = Int(value), seconds > 0 else {
            lastError = "Interval must be a positive number of seconds."
            renderMenu()
            return
        }
        do {
            try preferencesStore.update { $0.heartbeatIntervalSeconds = seconds }
            renderMenu()
        } catch {
            lastError = error.localizedDescription
            renderMenu()
        }
    }

    @objc private func setDefaultCodexArgs() {
        guard let value = prompt(
            title: "Default Codex Arguments",
            message: "Passed through after codex-heartbeat codex options.",
            value: preferencesStore.preferences.codexArgs
        ) else { return }
        do {
            try preferencesStore.update { $0.codexArgs = value }
            renderMenu()
        } catch {
            lastError = error.localizedDescription
            renderMenu()
        }
    }

    @objc private func toggleKeepHeartbeat() {
        do {
            try preferencesStore.update { $0.keepHeartbeat.toggle() }
            renderMenu()
        } catch {
            lastError = error.localizedDescription
            renderMenu()
        }
    }

    @objc private func openSettingsWindow() {
        let controller = settingsWindowController ?? SettingsWindowController(preferencesStore: preferencesStore) { [weak self] in
            self?.renderMenu()
        }
        settingsWindowController = controller
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func openDashboardWindow() {
        let controller = dashboardWindowController ?? DashboardWindowController(
            runner: runner,
            preferencesStore: preferencesStore,
            onStartCodex: { [weak self] in
                self?.startCodexWithHeartbeat()
            },
            onChanged: { [weak self] in
                self?.refresh()
            }
        )
        dashboardWindowController = controller
        controller.update(status: latestStatus, lastError: lastError)
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func openPreferencesFile() {
        do {
            try preferencesStore.save()
            NSWorkspace.shared.open(preferencesStore.preferencesURL)
        } catch {
            lastError = error.localizedDescription
            renderMenu()
        }
    }

    @objc private func refreshAction() {
        refresh()
    }

    @objc private func enableLaunchAtLogin() {
        do {
            try LaunchAgentManager.install(cliPath: runner.cliPath, loadNow: false)
            refresh()
        } catch {
            lastError = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            renderMenu()
        }
    }

    @objc private func disableLaunchAtLogin() {
        do {
            try LaunchAgentManager.uninstall()
            refresh()
        } catch {
            lastError = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            renderMenu()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
