import ReplayKit
import VideoToolbox
import Network
import UIKit

/// Broadcast extension: takes the screen from ReplayKit, compresses it to H.264 with the hardware
/// encoder and sends it to MirrorDesk (protocol in the desktop app's src/ios.js).
final class SampleHandler: RPBroadcastSampleHandler {
    // Stream settings follow the original's Android defaults (MECHANICS.md):
    private let bitRate = 7_581_600        // AppSettings DirectABitRate
    private let frameRate: Double = 30     // AppSettings DirectFrameRate
    private let keyFrameEvery = 60         // one key frame every 2 s (estimated)
    private let maxQueuedBytes = 2_000_000 // drop non-key frames when Wi-Fi falls behind (estimated)

    private let queue = DispatchQueue(label: "mirrordesk.sender")
    private var connection: NWConnection?   // the link in use (Wi-Fi or USB), chosen by whichever is ready first
    private var wifi: NWConnection?
    private var usbListener: NWListener?
    /// MirrorDesk reaches this port through the USB cable (usbmuxd), see the desktop app's src/usbmux.js.
    private static let usbPort: NWEndpoint.Port = 15488
    private var session: VTCompressionSession?
    private var sessionSize = (width: Int32(0), height: Int32(0))
    private var welcomed = false
    private var lastFrame = CMTime.invalid
    private var queuedBytes = 0
    private var frameCount = 0

    // MARK: broadcast life

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        queue.async {
            // USB: wait for MirrorDesk to connect through the cable. Wi-Fi: dial the computer if a code was typed.
            self.startUsbListener()
            if let ip = ScreenCode.ipAddress(from: SharedSettings.code),
               let port = NWEndpoint.Port(rawValue: UInt16(SharedSettings.port)) {
                let conn = NWConnection(host: NWEndpoint.Host(ip), port: port, using: .tcp)
                self.wifi = conn
                self.offer(conn, wifiAddress: ip)
            } else if self.usbListener == nil {
                self.stop("Open MirrorDesk Sender and type the screen code shown on the computer.")
            }
        }
    }

    override func broadcastFinished() {
        queue.sync {
            if let s = session { VTCompressionSessionInvalidate(s) }
            session = nil
            connection?.cancel()
            connection = nil
            wifi?.cancel()
            wifi = nil
            usbListener?.cancel()
            usbListener = nil
        }
    }

    // MARK: links (USB and Wi-Fi)

    private func startUsbListener() {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback // usbmuxd delivers cable connections on the phone's loopback
        guard let listener = try? NWListener(using: params, on: Self.usbPort) else { return }
        listener.newConnectionHandler = { [weak self] conn in self?.offer(conn, wifiAddress: nil) }
        listener.start(queue: queue)
        usbListener = listener
    }

    /// Uses the first link that becomes ready; later ones are closed.
    private func offer(_ conn: NWConnection, wifiAddress: String?) {
        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                if self.connection == nil {
                    self.connection = conn
                    self.sendHello()
                } else if self.connection !== conn {
                    conn.cancel()
                }
            case .failed, .waiting:
                guard self.connection !== conn else { return } // the link in use reports its end in watchForClose
                conn.cancel()
                if let ip = wifiAddress { self.wifiFailed(ip) }
            default: break
            }
        }
        conn.start(queue: queue)
    }

    /// Wi-Fi failed: give the USB cable a few seconds before giving up.
    private func wifiFailed(_ ip: String) {
        queue.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, self.connection == nil else { return }
            self.stop("Can't reach the computer at \(ip). Is MirrorDesk open and on the same Wi-Fi, or is the USB cable plugged in?")
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return } // phone sound is not sent in this version
        queue.async { self.encode(sampleBuffer) }
    }

    private func stop(_ message: String) {
        finishBroadcastWithError(NSError(domain: "MirrorDesk", code: 1,
                                         userInfo: [NSLocalizedDescriptionKey: message]))
    }

    // MARK: handshake

    private func sendHello() {
        let screen = UIScreen.main.nativeBounds
        let hello: [String: Any] = [
            "type": "hello", "code": SharedSettings.code, "name": SharedSettings.name,
            "width": Int(screen.width), "height": Int(screen.height)
        ]
        var line = (try? JSONSerialization.data(withJSONObject: hello)) ?? Data()
        line.append(10)
        connection?.send(content: line, completion: .contentProcessed { _ in })
        readReply(Data())
    }

    private func readReply(_ soFar: Data) {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, done, _ in
            guard let self = self else { return }
            var got = soFar
            if let d = data { got.append(d) }
            if let nl = got.firstIndex(of: 10) {
                let json = (try? JSONSerialization.jsonObject(with: got[..<nl])) as? [String: Any]
                if json?["type"] as? String == "welcome" {
                    self.welcomed = true
                    self.watchForClose()
                } else {
                    self.stop((json?["reason"] as? String) ?? "The computer refused the connection.")
                }
            } else if done {
                self.stop("The computer closed the connection.")
            } else {
                self.readReply(got)
            }
        }
    }

    private func watchForClose() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 1024) { [weak self] _, _, done, error in
            guard let self = self else { return }
            if done || error != nil { self.stop("Mirroring was stopped on the computer.") }
            else { self.watchForClose() }
        }
    }

    // MARK: encoding

    private func encode(_ sample: CMSampleBuffer) {
        guard welcomed, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        if lastFrame.isValid, CMTimeGetSeconds(CMTimeSubtract(time, lastFrame)) < 1.0 / frameRate - 0.004 { return }
        lastFrame = time

        let w = Int32(CVPixelBufferGetWidth(pixels)), h = Int32(CVPixelBufferGetHeight(pixels))
        if session == nil || sessionSize != (w, h) { makeSession(width: w, height: h) }
        guard let session = session else { return }

        var props: CFDictionary?
        if frameCount % keyFrameEvery == 0 {
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }
        frameCount += 1
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixels, presentationTimeStamp: time,
                                        duration: .invalid, frameProperties: props,
                                        infoFlagsOut: nil) { [weak self] status, _, out in
            guard status == noErr, let out = out, let self = self else { return }
            self.queue.async { self.send(out) }
        }
    }

    private func makeSession(width: Int32, height: Int32) {
        if let old = session { VTCompressionSessionInvalidate(old) }
        session = nil
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil, width: width, height: height,
                                                codecType: kCMVideoCodecType_H264,
                                                encoderSpecification: nil, imageBufferAttributes: nil,
                                                compressedDataAllocator: nil, outputCallback: nil,
                                                refcon: nil, compressionSessionOut: &s)
        guard status == noErr, let made = s else { return }
        VTSessionSetProperty(made, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(made, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(made, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(made, key: kVTCompressionPropertyKey_AverageBitRate, value: bitRate as CFNumber)
        VTSessionSetProperty(made, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: frameRate as CFNumber)
        VTSessionSetProperty(made, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: keyFrameEvery as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(made)
        session = made
        sessionSize = (width, height)
        frameCount = 0
    }

    // MARK: sending

    private static let startCode: [UInt8] = [0, 0, 0, 1]

    private func send(_ sample: CMSampleBuffer) {
        guard let conn = connection, let block = CMSampleBufferGetDataBuffer(sample) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let isKey = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        if !isKey && queuedBytes > maxQueuedBytes { return }

        var payload = Data()
        // Key frames carry the stream settings (SPS/PPS) so the computer can start at any key frame.
        if isKey, let format = CMSampleBufferGetFormatDescription(sample) {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                               nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                      parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                      nalUnitHeaderLengthOut: nil) == noErr, let p = ptr {
                    payload.append(contentsOf: Self.startCode)
                    payload.append(p, count: size)
                }
            }
        }
        // The encoder writes 4-byte lengths before each unit; the computer expects start codes.
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length,
                                          dataPointerOut: &pointer) == noErr, let base = pointer else { return }
        base.withMemoryRebound(to: UInt8.self, capacity: length) { bytes in
            var offset = 0
            while offset + 4 <= length {
                let n = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
                offset += 4
                guard n > 0, offset + n <= length else { break }
                payload.append(contentsOf: Self.startCode)
                payload.append(bytes + offset, count: n)
                offset += n
            }
        }

        var header = Data(count: 12)
        let flags: UInt32 = isKey ? 0x4000_0000 : 0
        header.withUnsafeMutableBytes { raw in
            raw.storeBytes(of: flags.bigEndian, toByteOffset: 0, as: UInt32.self)
            raw.storeBytes(of: UInt32(0).bigEndian, toByteOffset: 4, as: UInt32.self)
            raw.storeBytes(of: UInt32(payload.count).bigEndian, toByteOffset: 8, as: UInt32.self)
        }
        let packet = header + payload
        queuedBytes += packet.count
        conn.send(content: packet, completion: .contentProcessed { [weak self] _ in
            self?.queue.async { self?.queuedBytes -= packet.count }
        })
    }
}
