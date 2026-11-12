import ReplayKit
import VideoToolbox
import Network
import UIKit

/// Broadcast extension: takes the screen from ReplayKit, compresses it to H.264 with the hardware
/// encoder and sends it to MirrorDesk (protocol in the desktop app's src/ios.js).
final class SampleHandler: RPBroadcastSampleHandler {
    // Stream settings (60 fps cap; ReplayKit may deliver fewer frames than this):
    private let bitRate = 12_000_000       // raised from the original's 7_581_600 for twice the frames
    private let frameRate: Double = 60     // was 30 (AppSettings DirectFrameRate)
    private let keyFrameEvery = 120        // one key frame every 2 s
    private let maxQueuedBytes = 2_000_000 // drop non-key frames when Wi-Fi falls behind (estimated)

    private let queue = DispatchQueue(label: "mirrordesk.sender")
    private var connection: NWConnection?   // the link in use (Wi-Fi or USB), chosen by whichever is ready first
    private var wifi: NWConnection?
    private var usbListener: NWListener?
    /// MirrorDesk connects to this port through the USB cable (src/usbmux.js) or over Wi-Fi after the
    /// app registered with the screen code (src/iosdial.js). It closes as soon as one link is in use.
    private static let usbPort: NWEndpoint.Port = 15488
    private var session: VTCompressionSession?
    private var sessionSize = (width: Int32(0), height: Int32(0))
    private var welcomed = false
    private var lastFrame = CMTime.invalid
    private var queuedBytes = 0
    private var frameCount = 0
    private var orientation: UInt32 = 0     // CGImagePropertyOrientation of the screen picture (0 = unknown)

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
            } else {
                self.queue.asyncAfter(deadline: .now() + 15) { [weak self] in
                    guard let self = self, self.connection == nil else { return }
                    self.stop("MirrorDesk didn't connect. Plug in the USB cable, or open MirrorDesk Sender on the same Wi-Fi as the computer and check the screen code.")
                }
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
        let params = NWParameters.tcp // all interfaces: loopback for the USB cable (usbmuxd), Wi-Fi for MirrorDesk
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
                    self.usbListener?.cancel() // one link only: nobody else can connect from now on
                    self.usbListener = nil
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
        switch sampleBufferType {
        case .video: queue.async { self.encode(sampleBuffer) }
        case .audioApp: queue.async { self.sendAudio(sampleBuffer) } // phone sound; the microphone is not sent
        default: break
        }
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
        if let o = CMGetAttachment(sample, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber {
            orientation = o.uint32Value // the picture stays upright-portrait; the computer turns it
        }

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
            raw.storeBytes(of: self.orientation.bigEndian, toByteOffset: 4, as: UInt32.self) // see src/ios.js
            raw.storeBytes(of: UInt32(payload.count).bigEndian, toByteOffset: 8, as: UInt32.self)
        }
        let packet = header + payload
        queuedBytes += packet.count
        conn.send(content: packet, completion: .contentProcessed { [weak self] _ in
            self?.queue.async { self?.queuedBytes -= packet.count }
        })
    }

    // MARK: sound

    /// Sends app sound as 16-bit little-endian interleaved PCM. Header flags bit 28 marks sound;
    /// the second header word is (sample rate << 8) | channel count (see src/ios.js).
    private func sendAudio(_ sample: CMSampleBuffer) {
        guard welcomed, let conn = connection, queuedBytes <= maxQueuedBytes,
              let format = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM else { return }
        let frames = CMSampleBufferGetNumSamples(sample)
        let channels = Int(asbd.mChannelsPerFrame)
        let bits = Int(asbd.mBitsPerChannel)
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let bigEndian = asbd.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        guard frames > 0, channels > 0, channels <= 8,
              (isFloat && bits == 32) || (!isFloat && (bits == 16 || bits == 32)) else { return }

        var listSize = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &listSize, bufferListOut: nil,
                                                                bufferListSize: 0, blockBufferAllocator: nil,
                                                                blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard listSize > 0 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil, bufferListOut: list,
                                                                      bufferListSize: listSize, blockBufferAllocator: nil,
                                                                      blockBufferMemoryAllocator: nil,
                                                                      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                                                                      blockBufferOut: &block) == noErr else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let bytesPer = bits / 8

        var pcm = Data(count: frames * channels * 2)
        pcm.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) in
            for f in 0..<frames {
                for c in 0..<channels {
                    let index = nonInterleaved ? c : 0
                    let offset = nonInterleaved ? f * bytesPer : (f * channels + c) * bytesPer
                    guard index < buffers.count, let base = buffers[index].mData,
                          offset + bytesPer <= Int(buffers[index].mDataByteSize) else { continue }
                    let p = base.advanced(by: offset)
                    var value: Int16
                    if bits == 16 {
                        var u: UInt16 = 0
                        memcpy(&u, p, 2)
                        value = Int16(bitPattern: bigEndian ? u.byteSwapped : u)
                    } else {
                        var u: UInt32 = 0
                        memcpy(&u, p, 4)
                        if bigEndian { u = u.byteSwapped }
                        if isFloat {
                            value = Int16(max(-1, min(1, Float(bitPattern: u))) * 32767)
                        } else {
                            value = Int16(truncatingIfNeeded: Int32(bitPattern: u) >> 16)
                        }
                    }
                    out.storeBytes(of: value.littleEndian, toByteOffset: (f * channels + c) * 2, as: Int16.self)
                }
            }
        }

        var header = Data(count: 12)
        let aux = UInt32(asbd.mSampleRate) << 8 | UInt32(channels)
        header.withUnsafeMutableBytes { raw in
            raw.storeBytes(of: UInt32(0x1000_0000).bigEndian, toByteOffset: 0, as: UInt32.self)
            raw.storeBytes(of: aux.bigEndian, toByteOffset: 4, as: UInt32.self)
            raw.storeBytes(of: UInt32(pcm.count).bigEndian, toByteOffset: 8, as: UInt32.self)
        }
        let packet = header + pcm
        queuedBytes += packet.count
        conn.send(content: packet, completion: .contentProcessed { [weak self] _ in
            self?.queue.async { self?.queuedBytes -= packet.count }
        })
    }
}
