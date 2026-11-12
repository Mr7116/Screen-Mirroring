# MirrorDesk Sender (iPhone / iPad)

Shows the iPhone screen in MirrorDesk on your computer, over Wi-Fi. It uses Apple's ReplayKit
screen broadcast and the iPhone's hardware H.264 encoder.

## Build it once (needs a Mac)
1. Install Xcode from the App Store, and XcodeGen: `brew install xcodegen`.
2. Copy this `ios-sender` folder to the Mac and, in it, run `xcodegen`.
3. In `project.yml` and `Shared/Shared.swift`, change `com.example.mirrordesk` to something of your own
   (for example `com.yourname.mirrordesk`), then run `xcodegen` again.
4. Open `MirrorSender.xcodeproj`, sign in with your Apple ID (Xcode → Settings → Accounts),
   choose your team for both targets, plug in the iPhone and press Run.

## Use it
1. Open MirrorDesk on the computer and look at the **iPhone** tab for the screen code.
2. On the iPhone, open **MirrorDesk Sender**, type the code, tap the round button and **Start Broadcast**.
3. The iPhone screen opens in its own window on the computer. Stop from the red status bar or Control Centre.

## Limits
- The computer can't tap or type on an iPhone (Apple doesn't allow it).
- Phone sound is not sent yet.
- When the iPhone is sideways the picture comes upright; press **Rotate** (Ctrl+Z) on the computer.
