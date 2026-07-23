import ExpoModulesCore
import ExternalAccessory

/**
 * Native External Accessory transport for the TSL ASCII 2.0 reader (Vulcan RFID
 * Indium / TSL 1128).
 *
 * Opens an `EASession` for the `com.uk.tsl.rfid` protocol, streams incoming
 * bytes to JS as `onData` events (UTF-8), and writes `send` payloads to the
 * output stream — buffering when the stream has no free space. Accessory
 * connect/disconnect notifications are re-emitted to JS as `onConnectionChange`.
 *
 * Liveness: registers for `EAAccessoryDidConnect`/`EAAccessoryDidDisconnect`
 * local notifications (`registerForLocalNotifications` is required for either
 * to fire — e.g. toggling Bluetooth off/on). On disconnect the session is torn
 * down and `onConnectionChange: false` is emitted; on reconnect, if JS has
 * expressed interest (`wantsConnection`, set by `connect()` and cleared by an
 * explicit `disconnect()`), the session is re-opened automatically and
 * `onConnectionChange: true` is emitted. Stream `.endEncountered`/`.errorOccurred`
 * are treated as disconnects too (the accessory may vanish without a notification).
 *
 * The stream delegate runs on a dedicated thread's run loop so reads/writes
 * never block the main thread.
 */
public class TslTransportModule: Module {
  /// The protocol string the TSL sled advertises over External Accessory.
  static let defaultProtocol = "com.uk.tsl.rfid"

  private var session: EASession?
  private var streamThread: StreamThread?

  /// `StreamDelegate` requires `NSObjectProtocol`, and Expo `Module` subclasses
  /// are not `NSObject`s — so a small NSObject proxy owns the conformance and
  /// forwards stream events back to this module.
  private lazy var streamDelegate = StreamDelegateProxy(owner: self)

  /// Pending output bytes when the output stream has no space available.
  private let outputLock = NSLock()
  private var outputBuffer = Data()

  /// The protocol string of the currently (or most recently) open session, so
  /// an `EAAccessoryDidConnect` reconnect can re-open the same protocol.
  private var lastProtocol: String?

  /// True when JS wants an active session — set by `connect()`, cleared by an
  /// explicit `disconnect()`. Survives an accessory drop so a reconnect
  /// (`EAAccessoryDidConnect`) re-opens the session automatically.
  private var wantsConnection = false

  /// Observers for `EAAccessoryDidConnect`/`EAAccessoryDidDisconnect`. Registered
  /// in `OnCreate` (before any `connect()`) so a sled that appears after launch
  /// is still observed.
  private var connectObserver: NSObjectProtocol?
  private var disconnectObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("TslTransport")
    Events("onData", "onConnectionChange")

    // Register for local accessory notifications BEFORE observing them. Apple
    // only posts `EAAccessoryDidConnect`/`EAAccessoryDidDisconnect` to apps that
    // have called `registerForLocalNotifications`; without this, toggling
    // Bluetooth off/on (which tears down / re-establishes the MFi accessory
    // session) is invisible to the module.
    OnCreate {
      EAAccessoryManager.shared().registerForLocalNotifications()
      let center = NotificationCenter.default
      self.connectObserver = center.addObserver(
        forName: .EAAccessoryDidConnect,
        object: nil,
        queue: .main
      ) { [weak self] notification in
        self?.handleAccessoryConnect(notification)
      }
      self.disconnectObserver = center.addObserver(
        forName: .EAAccessoryDidDisconnect,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.handleAccessoryDisconnect()
      }
    }

    OnDestroy {
      EAAccessoryManager.shared().unregisterForLocalNotifications()
      if let o = self.connectObserver {
        NotificationCenter.default.removeObserver(o)
        self.connectObserver = nil
      }
      if let o = self.disconnectObserver {
        NotificationCenter.default.removeObserver(o)
        self.disconnectObserver = nil
      }
      self.closeSession()
    }

    // List connected MFi accessories with their advertised protocol strings.
    Function("listAccessories") {
      return EAAccessoryManager.shared().connectedAccessories.map { accessory in
        return [
          "name": accessory.name,
          "protocolStrings": accessory.protocolStrings,
        ] as [String: Any]
      }
    }

    // Open an EASession for the given protocol string. Resolves true on success.
    AsyncFunction("connect") { (protocolString: String) -> Bool in
      return self.connect(protocolString: protocolString)
    }

    // Close the session and stop the stream thread (explicit JS disconnect).
    AsyncFunction("disconnect") {
      self.wantsConnection = false
      self.closeSession()
      self.sendEvent("onConnectionChange", ["connected": false])
    }

    // Write a command string to the reader (buffered if the stream is full).
    AsyncFunction("send") { (data: String) in
      self.sendData(data)
    }
  }

  // MARK: - Connection

  private func connect(protocolString: String) -> Bool {
    // JS asked to connect: remember the protocol and that it wants a session so
    // a later `EAAccessoryDidConnect` (sled reappearing after BT toggle) can
    // re-open automatically.
    wantsConnection = true
    lastProtocol = protocolString

    // Tear down any stale session first (no event — we emit the result below).
    closeSession()

    guard let accessory = EAAccessoryManager.shared().connectedAccessories
            .first(where: { $0.protocolStrings.contains(protocolString) }) else {
      return false
    }
    return openSession(accessory: accessory, protocolString: protocolString)
  }

  /// Open (or re-open) an EASession for the accessory. Emits `onConnectionChange:
  /// true` on success. Does NOT touch `wantsConnection` — callers manage that.
  private func openSession(accessory: EAAccessory, protocolString: String) -> Bool {
    guard let eaSession = EASession(accessory: accessory, forProtocol: protocolString) else {
      return false
    }
    self.session = eaSession
    if let input = eaSession.inputStream {
      input.delegate = streamDelegate
    }
    if let output = eaSession.outputStream {
      output.delegate = streamDelegate
    }

    let thread = StreamThread(
      inputStream: eaSession.inputStream,
      outputStream: eaSession.outputStream
    )
    self.streamThread = thread
    thread.start()

    sendEvent("onConnectionChange", ["connected": true])
    return true
  }

  /// Tear down the current session + stream thread and clear the output buffer.
  /// Emits nothing and does not clear `wantsConnection` — callers decide.
  private func closeSession() {
    streamThread?.cancel()
    streamThread = nil
    session = nil
    outputLock.lock()
    outputBuffer.removeAll(keepingCapacity: false)
    outputLock.unlock()
  }

  /// `EAAccessoryDidConnect`: the sled (re)appeared. If JS still wants a session,
  /// re-open it on the last-used protocol and emit the new connection state.
  private func handleAccessoryConnect(_ notification: Notification) {
    guard wantsConnection, session == nil else { return }
    let protocolString = lastProtocol ?? Self.defaultProtocol

    // Prefer the accessory the system handed us; fall back to a scan if absent.
    let accessory: EAAccessory? = (notification.userInfo?[EAAccessoryKey] as? EAAccessory)
      ?? EAAccessoryManager.shared().connectedAccessories
        .first(where: { $0.protocolStrings.contains(protocolString) })
    guard let accessory = accessory else { return }

    let ok = openSession(accessory: accessory, protocolString: protocolString)
    if !ok {
      // Re-open failed — surface the disconnect so JS isn't left in limbo; the
      // next `EAAccessoryDidConnect` will retry.
      sendEvent("onConnectionChange", ["connected": false])
    }
  }

  /// `EAAccessoryDidDisconnect`: the sled vanished (Bluetooth off, unpaired,
  /// power loss). Tear down and notify JS. `wantsConnection` is preserved so a
  /// reconnect can re-open.
  private func handleAccessoryDisconnect() {
    closeSession()
    sendEvent("onConnectionChange", ["connected": false])
  }

  // MARK: - Writing

  private func sendData(_ data: String) {
    let bytes = Array(data.utf8)
    outputLock.lock()
    outputBuffer.append(contentsOf: bytes)
    outputLock.unlock()
    flushOutput()
  }

  /// Drain the output buffer to the output stream when it has free space.
  private func flushOutput() {
    guard let output = session?.outputStream else { return }
    outputLock.lock()
    let pending = outputBuffer
    outputLock.unlock()
    guard !pending.isEmpty else { return }

    let written = pending.withUnsafeBytes { buffer -> Int in
      guard let base = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
        return 0
      }
      return output.write(base, maxLength: pending.count)
    }
    guard written > 0 else { return }

    outputLock.lock()
    if written < outputBuffer.count {
      outputBuffer.removeFirst(written)
    } else {
      outputBuffer.removeAll(keepingCapacity: false)
    }
    outputLock.unlock()
  }
}

// MARK: - Stream delegate

/// NSObject proxy owning the `StreamDelegate` conformance (Expo `Module`
/// subclasses cannot conform — `StreamDelegate` requires `NSObjectProtocol`).
/// Holds its owner weakly; the module strongly retains the proxy.
private final class StreamDelegateProxy: NSObject, StreamDelegate {
  private weak var owner: TslTransportModule?

  init(owner: TslTransportModule) {
    self.owner = owner
  }

  func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
    owner?.handleStreamEvent(aStream, eventCode)
  }
}

extension TslTransportModule {
  /// Dispatch a stream event from the delegate proxy.
  fileprivate func handleStreamEvent(_ aStream: Stream, _ eventCode: Stream.Event) {
    switch eventCode {
    case .hasBytesAvailable:
      guard let input = aStream as? InputStream else { return }
      readAvailable(input)
    case .hasSpaceAvailable:
      flushOutput()
    case .endEncountered:
      // Stream closed (e.g. accessory gone). Treat as a disconnect but keep
      // `wantsConnection` so a reconnect can re-open.
      handleStreamDisconnect()
    case .errorOccurred:
      handleStreamDisconnect()
    default:
      break
    }
  }

  /// Stream-level disconnect: tear down + notify JS. Keeps `wantsConnection`.
  fileprivate func handleStreamDisconnect() {
    closeSession()
    sendEvent("onConnectionChange", ["connected": false])
  }

  private func readAvailable(_ input: InputStream) {
    let bufferSize = 1024
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    while input.hasBytesAvailable {
      let read = input.read(&buffer, maxLength: bufferSize)
      if read < 0 {
        handleStreamDisconnect()
        return
      }
      if read == 0 {
        return
      }
      let chunk = Data(bytes: buffer, count: read)
      if let str = String(data: chunk, encoding: .utf8) {
        sendEvent("onData", ["chunk": str])
      }
    }
  }
}

// MARK: - Stream thread

/// A dedicated thread that owns the run loop the input/output streams are
/// scheduled on, so stream delegate callbacks never block the main thread.
private final class StreamThread: Thread {
  private let inputStream: InputStream?
  private let outputStream: OutputStream?

  init(inputStream: InputStream?, outputStream: OutputStream?) {
    self.inputStream = inputStream
    self.outputStream = outputStream
  }

  override func main() {
    let runLoop = RunLoop.current
    if let input = inputStream {
      input.schedule(in: runLoop, forMode: .default)
      input.open()
    }
    if let output = outputStream {
      output.schedule(in: runLoop, forMode: .default)
      output.open()
    }

    while !isCancelled {
      runLoop.run(until: Date(timeIntervalSinceNow: 1.0))
    }

    inputStream?.remove(from: RunLoop.current, forMode: .default)
    outputStream?.remove(from: RunLoop.current, forMode: .default)
    inputStream?.close()
    outputStream?.close()
  }
}
