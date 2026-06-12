# EV Project Engineer Dashboard

แดชบอร์ดติดตามงานสำหรับโครงการติดตั้งสถานีอัดประจุไฟฟ้า

## ฟีเจอร์

- ติดตาม 4 ขั้นตอนหลัก: Survey, Pre-Construction, Construction, Commissioning
- รายงานความคืบหน้าหน้างาน
- แนบรูปถ่ายลงในรายงาน
- อัปเดตแบบเรียลไทม์ผ่าน Server-Sent Events
- เข้าถึงด้วยรหัสเชิญก่อนเข้าใช้งาน

## รหัสเชิญเริ่มต้น

- `EV-TEAM-2026`

> ถ้าจะใช้งานจริง ควรเปลี่ยนรหัสนี้เป็นรหัสของคุณเองใน `server.js` หรือเพิ่มรหัสใหม่ใน `data/state.json`

## รันในเครื่อง

```powershell
node .\ev-dashboard\server.js
```

จากนั้นเปิด:

```text
http://localhost:3000
```

## Deploy จริง

ไฟล์ที่เตรียมไว้สำหรับโฮสต์จริง:

- [`Dockerfile`](./Dockerfile)
- [`render.yaml`](./render.yaml)
- [`package.json`](./package.json)

ค่าที่ควรตั้งบนโฮสต์:

- `APP_DATA_DIR=/data`
- `EV_INVITE_SECRET=<ค่าลับที่เดายาก>`

เมื่อ deploy สำเร็จแล้ว แนะนำให้ mount persistent disk ไปที่ `/data`
เพื่อเก็บข้อมูลโครงการและไฟล์รูปให้ไม่หายเมื่อรีสตาร์ตเครื่องโฮสต์

## โครงสร้างข้อมูล

- `data/state.json` เก็บสถานะงานทั้งหมด
- `uploads/` เก็บรูปที่อัปโหลด
