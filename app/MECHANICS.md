# How the original works (what this rebuild follows)

The original program is a small .NET wrapper ("NETZ") that keeps the real program compressed
inside itself. It was unpacked (zlib) and the real program (version 1.8.45, .NET Framework 4.5,
WinForms) was read with the .NET tools. Places are given as `Class::Method` because .NET code has
method tokens rather than machine addresses. Values marked *estimated* were looked for in the
code and not found.

## Parts of the original

| Part | Where in the original | What it does |
| --- | --- | --- |
| Android over USB / Wi-Fi | `Mirror.MirrorLib` → libmirrorcontrol.dll (`WXControlStart(deviceInfo, usb, ...)`, `WXStartAndroidVideo(id, bUsb, ip)`) plus adb.exe and a helper APK | Starts a helper on the phone through adb and receives H.264 video. |
| Reverse control | `MirrorLib::WXSendTouchEvent(id, x, y, windowW, windowH, type)`, `WXSendKeyboardEvent`, `WXKeyboardInputString` | Touch types `BUTTON_DOWN`, `BUTTON_UP`, `MOUSEMOVE`; key types include back/home/app switch/power/volume/cut/copy/paste. Touch points are sent with the window size and scaled on the phone. |
| iPhone control | `BleLib.BleControlLib` (libwxbtc.dll: `SendMouse`, `SendKeybd`) | Pretends to be a Bluetooth mouse/keyboard. Not rebuilt. |
| AirPlay / Chromecast / DLNA | libairplay.dll, libchromecast.dll, WXDLNAReceiver.dll | Standard receivers. Not rebuilt. |
| Screen code | `Controls.ScreenCodeCtrl::IpToPinCode` | Code = hex of the computer's IPv4 bytes 3–4 when the address is 192.168.x.x, otherwise hex of all 4 bytes. |
| LAN service | `WebConnect.WebQR::InterStartService` | Tries ports starting at **15486**. |
| Whiteboard | `WhiteBoardForm`, `WhiteBoardOperForm`, `WhiteBoardColorForm`, `DrawingEdit.EditConfig` | Tools: None, Line, Rectangle, Highlighter, Text, Brush, Arrow, Ellipse; undo, redo, clear. |
| Screenshots | `ScreenshotHelper::.cctor` | Formats PNG / JPG; save to Clipboard or Computer. |
| Recording | `AppSettings::Load` (`Rec` section), `SettingSubPanelCapture` | MP4, quality High/Standard/Low, 30 fps, audio None / System sound / Microphone / both. |
| Hotkeys | `HotkeyHelper::.cctor` | See table below. |

## Numbers

### Default hotkeys (`HotkeyHelper::.cctor`)
| Action | Key |
| --- | --- |
| Screenshot | Ctrl+Q |
| Start/stop recording | Ctrl+R |
| Whiteboard | Ctrl+B |
| Full screen | Ctrl+F |
| Keep on top | Ctrl+P |
| Rotate | Ctrl+Z |
| Simple mode (hide toolbar) | Ctrl+S |
| Hide all windows ("boss key") | Alt+A |
| Back | Right mouse button |
| Home | Alt+1 |
| Recent apps | Alt+2 |
| Screen off | Ctrl+D |
| Volume up / down | Ctrl++ / Ctrl+- |
| Send typed text / new line | Enter / Ctrl+Enter |
| Pause or play | Ctrl+E |

### Stream defaults (`AppSettings::Load`, section `Main`)
- DirectDisplaySize **1080** (px), DirectFrameRate **30** fps, DirectABitRate **7 581 600** bit/s,
  DirectFrameInterval **20**, DirectRateMode **2**.
- AirplayQuality **1080P**; resolution choices (`SettingSubPanelDisplay::LoadConfigs`):
  720p 1280×720 (recommended), 1080p 1920×1080, 2K 2560×1440.
- The rebuild treats 1080 as the short side of the phone picture and never asks the phone for a
  long side above 1920 (*estimated*: phone encoders often refuse more).

### Capture defaults (`AppSettings::Load`, sections `Output` and `Rec`)
- Image format **PNG** (or JPG), image goes to **Computer** (or Clipboard).
- Video format **MP4**, quality **Standard**, frame rate **30**.
- Bit rate per quality: the original uses none (encoder presets instead, see "Recording" below); the rebuild's
  High 8 / Standard 4 / Low 1.5 Mbit/s are *estimated*.

### Whiteboard (`WhiteBoardColorForm::CreateColorRects`, `EditConfig::.cctor`)
- Colours in order: Red, Black, White, Blue, rgb(250,248,117), rgb(40,215,40).
- Default pen colour Red, highlighter colour Yellow, line width **4** px.
- Highlighter opacity 0.4 and width 5× the pen (*estimated*: the original never creates highlighter strokes,
  see "Whiteboard drawing" below).

### Control (`AppSettings::Load`, section `Control`)
- ScrollFactorX **20**, ScrollFactorY **10**: one wheel notch scrolls 10 % of the picture height
  (and 20 % of its width sideways) in the rebuild.
- A press that moves less than 8 px is a tap, held over 500 ms it is a long press (*estimated*).

### Window
- Main window 408×776, white, frameless, logo and title top-left, menu / minimise / close top-right
  (picture of the original).
- Mirror toolbar buttons 40×40 (`MirrorToolbarForm::InitializeButtons`), 21 button slots.

## Native code: libmirrorcontrol.dll (decompiled with Ghidra)

The .NET program calls `libmirrorcontrol.dll` for Android. Its exported `WX…` functions
(WXSendTouchEvent 0x10035060, WXSendKeyboardEvent 0x10034f30, WXSetFrameAndBitRate 0x10035260,
WXSetDisplaySize 0x100351f0, WXStartAndroidVideo 0x100355f0, WXControlStart 0x10034940…) only look up
the phone and pass the call to the C++ class `DeviceControl`. What that class does:

| Rule | Function (address) | Value / formula |
| --- | --- | --- |
| Default stream settings | `DeviceControl::DeviceControl` 0x100182f0 | display size **1080** (0x438), bit rate **8 000 000**, frame interval 1, frame rate **60** (0x3c), rate mode 2 |
| Control port | `DeviceControl::DeviceControl` 0x100182f0 | TCP **27183** (0x6a2f) |
| Phone keys mapped to WASD for games | `DeviceControl::DeviceControl` 0x100182f0 | W 0x57, S 0x53, A 0x41, D 0x44 (game mode, not rebuilt) |
| Allowed display sizes | `SetDisplaySize` 0x100215a0 | only **540, 720, 1080, 1440**; anything else refused |
| Frame and bit rate | `SetFrameABitRate` 0x10021610 | both must be ≥ 1 |
| Frame interval | `SetFrameInterval` 0x10021670 | 1…100 |
| Rate mode | `SetRateMode` 0x10021800 | 0, 1 or 2 |
| Helper copied to the phone | `adbPush` 0x1002c6b0 | `adb push android\libmirrorcontrol.jar /data/local/tmp/libmirrorcontrol.jar` |
| Helper started | `adbAppProcess` 0x1002bac0 | `CLASSPATH=/data/local/tmp/libmirrorcontrol.jar app_process /system/bin com.apowersoft.libmirror.Server 720 8000000 true - false` (a scrcpy-style server) |
| Port tunnel | `adbForward` 0x1002c3d0 | `adb forward tcp:27183 tcp:27183`; error text names `localabstract:qtscrcpy` |
| Handshake | `startScrcpy` 0x10032930 | socket send/receive timeout **1000 ms**; read **68 bytes**: 64-byte device name, then height and width as 2-byte big-endian numbers; on failure retry once after 500 ms |
| Video packets | `startReceive` 0x10032540 | 20-byte header, last 4 bytes = packet length (big-endian), then that many bytes of H.264 |
| Touch message | `scrcpySendTouchEvent` 0x10031e80 | waits **10 ms** before each message; action 0 down / 1 up / 2 move; point scaled `x * deviceW / windowW`, `y * deviceH / windowH` (W and H swapped when the phone is turned 90°/270°); 11-byte message type 5 with point and device size; a (0, y) or (x, 0) point is dropped |
| Touch leaving the picture | `SendTouchEvent` 0x100210a0 | a negative point turns into an "up" |
| Key message | `scrcpySendKeybdEvent` 0x10031b00 | press then release, **10 ms** apart; key codes: Enter 66, Up 19, Down 20, Left 21, Right 22, Home 3, Back 4, Power 26, App switch 187, Cut 277, Copy 278, Paste 279, Volume up 24, Volume down 25 |
| Phone screen off while mirroring | `scrcpySendScreenOffEvent` 0x10031dd0 | 2-byte message (type 9, on/off) |
| Typing any text | `InputMirrorKeybdString` 0x1001e000 | sent to a keyboard helper over HTTP (`Key=InputText&Value=…`), so any language works |

### How the rebuild follows it
- **Live control (default)**: like the original it pushes a helper to `/data/local/tmp`, starts it with
  `app_process`, forwards port **27183** and opens a picture socket and a control socket. The original's own
  helper jar is not copied; the rebuild downloads the open-source scrcpy server (v3.1, Apache-2.0), whose
  protocol is the documented successor of the one above (message layouts differ slightly; the rules are the
  same). Video packets are length-prefixed and decoded in the window.
- Touch: real down / move / up from the mouse, moves at most one per **10 ms**, points scaled to picture pixels
  with the picture size sent along (same formula), dragging off the picture ends the touch.
- Keys: the original's key codes above; press then release.
- Display sizes offered: **540, 720, 1080, 1440**, default 1080; bit rate default 7 581 600 from the .NET settings
  (the DLL's own 8 000 000 is overridden by them); frame rate 30 (setting) or 60 (DLL default).
- Screen off: sends the display-power message, so the phone goes dark but mirroring continues.
- Text: plain text as typed text; other languages (Thai…) through the phone clipboard and paste.
- **Basic control** (if the helper can't be downloaded): `screenrecord` + `adb shell input`, with the estimated
  tap/long-press thresholds below.

## Main program entry (native)

`ApowerMirror.exe` has one native function, its entry at **0x120975e** (Ghidra: `entry()` only jumps to
`_CorExeMain`, the .NET loader). Everything else in it is .NET code (packed with NETZ), read as .NET above.

## Recording (Recorder, Apowersoft.Utils.Record.dll, WXMedia.dll)

| Rule | Where | Value |
| --- | --- | --- |
| File name | `Recorder::GetOutputFilePath` | `<output folder>\yyyyMMdd_HHmmss.<format>` (no subfolder, no name prefix) |
| Quality → encoder mode | `Recorder::SetRecOptions` then `Rec.Option::SetToWXCaptureParam` | High → priority Quality → mode **2**; Standard → Balance → mode **1**; Low → Performance → mode **0** |
| Video bit rate | `Recorder::SetRecOptions` | **0** (×1000 in SetToWXCaptureParam), so the encoder decides |
| Frame rate | `Recorder::SetRecOptions`, `SetToWXCaptureParam` | RecHighFPS (30); **24** if not set; GIF records at **3** fps |
| Encoder per mode | WXMedia.dll `FUN_101916e0` 0x101916e0 | mode 0 preset **veryfast**, 1 ref frame; mode 1 **faster**, 3 refs; mode 2 **fast**, 4 refs; quantizer 10…51; profile Baseline; tune zerolatency |
| Audio bit rate | WXMedia.dll 0x101916e0 | **128000** when not given |
| Capture defaults | WXMedia.dll `WXCaptureDefaultParam` 0x1015c870 | mode 1, 24 fps, bit rate field 1 000 000 |

The rebuild records in the window with the browser's MediaRecorder, which has no encoder presets, only a
bit rate. So the three qualities still map to bit rates (High 8, Standard 4, Low 1.5 Mbit/s); these numbers
are **estimated**. The original's rule is "faster preset = lower quality", which this ordering keeps.

## Screenshots (ScreenshotHelper)

- `ScreenshotHelper::GetOutputFilePath`: `<output folder>\yyyyMMdd_HHmmss.<png|jpg>`.
- `ScreenshotHelper::GetWindowImage`: copies the mirror window's pixels (24-bit) with BitBlt.

## Whiteboard drawing (WhiteBoardForm, DrawingEdit.PathElement / BrushElement)

- `WhiteBoardForm::CreateElement`: only edit mode **5 (Brush)** makes an element. The other modes in the
  `EditMode` list (Line, Rectangle, Highlighter, Text, Arrow, Ellipse) never create anything in this version.
  The rebuild keeps those six tools as additions the request asked for (highlighting and marking).
- `PathElement::HandleDrawingMouseMove`: a new point is kept only when it is **≥ 2 px** from the last kept point.
- `PathElement::RecalculatePath`: with 3 or more points, the list is padded to 3n+1 points and drawn as
  cubic Béziers (`AddBeziers`); with 2 points, a straight line. Where the padding points go
  (`POINT_OFFSET`, 3 floats) wasn't readable; the rebuild repeats the last point (*estimated*).
- `BrushElement::SetDrawGraphicsMode`: anti-aliased drawing (SmoothingMode 2).
- Pen: colour from EditConfig (red), width EditConfig.DefaultLineWidth **4** (DPI-scaled).

## iPhone

How the original does it (decompiled):
- **USB**: libwxaus.dll (`startUsbScreen` 0x1002b960, `initUsbScreen` 0x1003c580, `getDevTrustState` 0x1003bd60)
  carries usbmuxd 1.1.1 and libimobiledevice lockdown pairing (`com.apple.mobile.lockdown.request_pair`) and
  Apple's USB screen-capture service ("iOSScreenCaptureAssistant", "too many ping failures, stop screen
  thread"). It needs a replaced USB driver (PreDriver, DriverSetup.exe).
- **Wi-Fi**: AirPlay receiver in libairplay.dll (`StartAirplay`, quality 1080P default), which needs Apple's
  FairPlay handshake.
- **Control**: Bluetooth mouse/keyboard emulation in libwxbtc.dll (`SendMouse`, `SendKeybd`).

None of these can be rebuilt inside this app, so the rebuild follows the person's own plan (iOS sender with
ReplayKit, Swift, hardware H.264):
- `ios-sender/`: a SwiftUI app plus a ReplayKit broadcast extension. It encodes the screen with VideoToolbox
  H.264 Baseline at **7 581 600 bit/s** and **30 fps** (the original's Android defaults, AppSettings::Load),
  a key frame every 60 frames (*estimated*), and drops non-key frames when more than 2 MB is waiting
  (*estimated*). Key frames carry SPS/PPS.
- Desktop receiver (`src/ios.js`): TCP on the Wi-Fi share port + 1 = **15487** (this rebuild's choice), the
  screen code checked the same way as everywhere else (ScreenCodeCtrl::IpToPinCode), then the same 12-byte
  length-prefixed H.264 packets the Android helper uses.
- iPhone camera: Safari opens the share page (port 15486) and shares the camera; iPhones can't share their
  screen from a browser.
- No control of iPhones and no iPhone sound in this version.

## How the rebuild does the same job
- **Android (USB or Wi-Fi)**: uses adb like the original, with the live helper described above
  (basic `screenrecord` + `input` only as a fallback). Wi-Fi uses adb over the network
  (`adb tcpip` / `adb connect`, or Android 11+ wireless debugging).
- **Browser sender over Wi-Fi**: the app serves a secure page on port 15486. Any device on the same
  network opens it, types the screen code and shares its screen (and tab audio) to the computer by
  WebRTC. Files can be sent both ways on the same page.
- **File transfer**: drop files on the mirror window to push them into the phone's Download folder;
  files sent from the browser page land in the output folder.
