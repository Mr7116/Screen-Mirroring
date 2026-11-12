# วิธีติดตั้ง MirrorDesk (ดูจอ iPhone บนคอม Windows)

ดาวน์โหลด 2 ไฟล์จากด้านล่างของหน้านี้ (หัวข้อ **Assets**)
- `MirrorDesk-Setup-….exe` สำหรับคอม
- `MirrorSender-unsigned.ipa` สำหรับ iPhone

## 1. ติดตั้งบนคอม
1. ดับเบิลคลิก `MirrorDesk-Setup-….exe`
   ถ้าขึ้น **"Windows protected your PC"** ให้กด **More info → Run anyway** (โปรแกรมยังไม่ได้เซ็นชื่อผู้พัฒนา)
2. เปิด MirrorDesk ครั้งแรก ถ้า Windows Firewall ถาม ให้ติ๊ก **Private networks** แล้วกด **Allow**
3. ตั้ง Wi-Fi ของคอมเป็น **Private**: Settings → Network & Internet → Wi-Fi → (ชื่อ Wi-Fi) → Private network
4. ติดตั้ง **iTunes** จาก https://www.apple.com/itunes/ (ตัวดาวน์โหลดจากเว็บ ไม่ใช่จาก Microsoft Store)
   ใช้ทั้งตอนติดตั้งแอปลง iPhone และตอนต่อด้วยสาย USB

## 2. ติดตั้งแอปลง iPhone (ใช้ Apple ID ของตัวเอง ฟรี)
1. ติดตั้ง **Sideloadly** จาก https://sideloadly.io
2. เสียบ iPhone กับคอม ปลดล็อก แล้วกด **เชื่อถือคอมพิวเตอร์นี้** บน iPhone
3. ลากไฟล์ `MirrorSender-unsigned.ipa` ใส่ Sideloadly ใส่ Apple ID แล้วกด **Start** (อาจต้องกรอกรหัสยืนยัน 6 หลัก)
4. บน iPhone
   - ตั้งค่า → ทั่วไป → **VPN และการจัดการอุปกรณ์** → กดชื่อ Apple ID ของคุณ → **เชื่อถือ**
   - ตั้งค่า → ความเป็นส่วนตัวและความปลอดภัย → **โหมดนักพัฒนา (Developer Mode)** → เปิด แล้วรีสตาร์ต
5. แอปจะใช้ได้ **7 วัน** แล้วต้องทำข้อ 3 ใหม่ (หรือเปิด auto-refresh ใน Sideloadly)

## 3. ใช้งาน
**ต่อด้วยสาย USB (ง่ายที่สุด)**
1. เปิด MirrorDesk บนคอม แล้วเสียบสาย iPhone
2. บน iPhone เปิด **MirrorDesk Sender** → กดปุ่มกลม → เลือก MirrorDesk Sender → **เริ่มการแชร์ (Start Broadcast)**
3. ภาพและเสียงจาก iPhone จะขึ้นในหน้าต่างใหม่บนคอม

**ต่อด้วย Wi-Fi**
1. iPhone กับคอมต้องอยู่ Wi-Fi วงเดียวกัน
2. ใน MirrorDesk ไปที่แท็บ **iPhone** ดู **รหัสหน้าจอ** (เช่น 0178)
3. เปิดแอป MirrorDesk Sender พิมพ์รหัส ถ้าถามเรื่อง **เครือข่ายท้องถิ่น** ให้กด **อนุญาต**
4. กดปุ่มกลม → **เริ่มการแชร์** (ภายใน 10 นาทีหลังเปิดแอป)

**ปุ่มในหน้าต่างภาพ**: เต็มจอ, ถ่ายภาพ, อัดวิดีโอ, ไวท์บอร์ด, หมุนจอ (สองทิศ), ปักหน้าต่างไว้บนสุด, เพิ่ม/ลดเสียง
หมุน iPhone เป็นแนวนอน ภาพบนคอมจะหมุนตามเอง

## ข้อจำกัด
- คอมกดหรือพิมพ์บน iPhone ไม่ได้ (Apple ไม่อนุญาต)
- ส่งเฉพาะเสียงแอป ไม่ส่งเสียงไมค์ และแอปที่มี DRM (เช่น Netflix) จะไม่มีเสียง/ภาพ
- Wi-Fi สาธารณะหรือ Wi-Fi แขกบางที่บล็อกการคุยกันระหว่างเครื่อง ให้ใช้สาย USB แทน
