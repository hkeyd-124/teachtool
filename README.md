# TeachTool 🎓

Bộ công cụ web hỗ trợ giáo viên tiểu học: chấm điểm thi đua, quản lý lớp, vòng quay may mắn, giáo án, điểm danh, thời khóa biểu.

Chạy trực tiếp trên trình duyệt — không cần build, không phụ thuộc thư viện ngoài.

## Cấu trúc

```
home.html                  # Trang chủ + hash router (#/star-race)
features/
  star-race/index.html     # ⭐ Chấm điểm nhóm (đã có)
api/
  config.js                # Runtime config — đọc Firebase keys từ ENV
vercel.json                # Rewrites + headers
.env.example               # Danh sách biến môi trường cần đặt
```

## Kiến trúc

- **Router**: `home.html` đọc `location.hash` (`#/<slug>`) và nạp `features/<slug>/index.html`
  vào iframe. Trang chủ **không nhúng code tính năng** — mỗi tính năng là một file độc lập,
  có thể mở trực tiếp bằng URL riêng.
- **Thêm tính năng mới**: tạo `features/<slug>/index.html`, thêm một mục vào mảng `FEATURES`
  trong `home.html` với `status: "live"`.
- **Cấu hình bí mật**: client đọc `api/config.js` (Vercel Serverless Function) trả về
  `window.TEACHTOOL_CONFIG`. Giá trị lấy từ Environment Variables — **không hardcode key
  trong source**. Nếu chưa cấu hình, ứng dụng chạy ở chế độ chỉ lưu trên máy (localStorage).

## Chạy local

```bash
# Cách đơn giản nhất: mở trực tiếp
open home.html

# Hoặc chạy static server (khuyến nghị, để iframe + api/config.js hoạt động)
npx serve .
```

## Deploy

Repo được cấu hình sẵn cho Vercel (static + serverless function). Import repo vào Vercel,
sau đó đặt các biến trong `.env.example` tại **Settings → Environment Variables**.

## Ghi chú bảo mật

- `.env` và mọi file chứa private key đã nằm trong `.gitignore`.
- `FIREBASE_SERVICE_ACCOUNT_JSON` chỉ dùng server-side; `api/config.js` **không** trả biến này ra client.
- Firebase Web SDK config (`apiKey`, `projectId`, …) là thông tin công khai theo thiết kế của
  Firebase — bảo vệ dữ liệu bằng **Firestore Security Rules**, không phải bằng cách giấu apiKey.
