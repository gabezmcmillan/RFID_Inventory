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

  /// Observer for `EAAccessoryDidDisconnectNotification`.
  private var disconnectObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("TslTransport")
    Events("onData", "onConnectionChange")

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

    // Close the session and stop the stream thread.
    AsyncFunction("disconnect") {
      self.disconnect()
    }

    // Write a command string to the reader (buffered if the stream is full).
    AsyncFunction("send") { (data: String) in
      self.sendData(data)
    }
  }

  // MARK: - Connection

  private func connect(protocolString: String) -> Bool {
    disconnect()

    guard let accessory = EAAccessoryManager.shared().connectedAccessories
            .first(where: { $0.protocolStrings.contains(protocolString) }) else {
      return false
    }
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

    // Watch for the sled being unplugged while connected.
    if disconnectObserver == nil {
      disconnectObserver = NotificationCenter.default.addObserver(
        forName: .EAAccessoryDidDisconnect,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.handleDisconnect()
      }
    }

    sendEvent("onConnectionChange", ["connected": true])
    return true
  }

  private func disconnect() {
    streamThread?.cancel()
    streamThread = nil
    session = nil
    outputLock.lock()
    outputBuffer.removeAll(keepingCapacity: false)
    outputLock.unlock()
  }

  private func handleDisconnect() {
    disconnect()
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
      handleDisconnect()
    case .errorOccurred:
      handleDisconnect()
    default:
      break
    }
  }

  private func readAvailable(_ input: InputStream) {
    let bufferSize = 1024
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    while input.hasBytesAvailable {
      let read = input.read(&buffer, maxLength: bufferSize)
      if read < 0 {
        handleDisconnect()
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
