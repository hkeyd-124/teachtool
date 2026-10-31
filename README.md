# TeachTool 🎓

Bộ công cụ web hỗ trợ giáo viên tiểu học: chấm điểm thi đua, quản lý lớp, vòng quay may mắn, giáo án, điểm danh, thời khóa biểu.

Chạy trực tiếp trên trình duyệt — không cần build, không phụ thuộc thư viện ngoài.

## Dữ liệu Firestore

**Toàn bộ dữ liệu tính năng đã lưu thật trên Firestore** — mỗi tài khoản một nhánh riêng,
đăng nhập ở máy nào cũng thấy cùng dữ liệu.

Cấu trúc tối ưu hạn ngạch Spark: **mỗi nhóm là một document** chứa mảng `students` + map `stars`;
cộng star tốn **1 write, 0 read**. Chi tiết đầy đủ (cây collection, ý nghĩa field, JSON mẫu,
bảng ước tính reads/writes/egress) tại **[docs/firestore-schema.md](docs/firestore-schema.md)**.

```
users/{uid}
  ├─ features/star-race/groups/{groupId}
  │    { name, order, emoji, color, students:[{id,name}], stars:{sid:n}, total,
  │      schoolId, schoolName, classId, className, ... }
  └─ features/star-race/meta/hierarchy       ← danh mục Trường → Lớp (1 doc)
       { schools:[{ id, name, order, classes:[{id,name,order}] }], updatedAt }
```

- `firestore.rules` — mỗi user chỉ đọc/ghi dữ liệu của chính mình (`request.auth.uid == uid`), mặc định từ chối.
- `firestore.indexes.json` — tắt index cho `students` / `stars` để giảm chi phí ghi.
- `js/db.js` — lớp truy cập dùng chung cho **mọi** tính năng: `increment` cho star, gộp thao tác 1,2 s thành 1 commit, chỉ 1 listener, tự huỷ khi rời trang.
  > ⚠️ `firestore.rules` **phải được deploy** thì mới ghi được. Xem [docs/firebase-setup.md](docs/firebase-setup.md).

## Cấu trúc

```
index.html                 # 🔐 Đăng nhập / Đăng ký (trang vào)
home.html                  # Trang chủ + hash router (#/star-race)
features/
  star-race/index.html     # ⭐ Chấm điểm nhóm — đọc/ghi thẳng Firestore qua /js/db.js
js/
  db.js                    # Lớp truy cập Firestore dùng chung (tối ưu quota)
api/
  config.js                # Runtime config — đọc Firebase keys từ ENV
firestore.rules            # Security rules (phải deploy)
firestore.indexes.json     # Index (không cần composite)
docs/
  firestore-schema.md      # Thiết kế dữ liệu + ước tính quota
  firebase-setup.md        # Hướng dẫn deploy rules, kiểm tra
vercel.json                # Rewrites + headers
.env.example               # Danh sách biến môi trường cần đặt
```

## Tính năng: Chấm điểm nhóm (star-race)

Trang `features/star-race/index.html` chạy hoàn toàn trên **Firestore** thông qua `js/db.js` —
không còn tự gọi Firestore, không còn logic lưu trữ riêng.

**Luồng dữ liệu**

| Thao tác | Gọi | Chi phí |
|---|---|---|
| Mở trang — cache trống | `TTDB.init()` → `TTDB.getHierarchy()` → `TTDB.subscribe()` | **N + 1 reads** (N nhóm + 1 danh mục trường/lớp), 1 listener |
| Mở trang — **F5 trong 60 s** | cache `sessionStorage` | **0 read** ⚡ |
| Cộng/trừ 1 sao | `TTDB.addStar()` / `removeStar()` | **1 write, 0 read** (increment + gộp 1,2 s) |
| Lưu cài đặt nhóm | `TTDB.syncGroup()` | 1 write / nhóm — **không còn ghi `stars`/`total`** ⚡ |
| Xoá học sinh | `TTDB.syncGroup()` | 2 write trong **1 commit** (PATCH + `increment` âm cho `total`) |
| Tạo nhóm mới | `TTDB.createGroup()` | 1 write (kèm luôn `schoolId/classId`) |
| Tạo trường / tạo lớp | `TTDB.createSchool()` / `createClass()` | **1 write** (cả danh mục trong 1 PATCH), 0–1 read ⚡ |
| Đổi lớp đang xem | `TTDB.getGroupsByClass()` | **0 read** (lọc trong bộ nhớ) |
| **Đổi tên lớp** | `TTDB.renameClassEverywhere()` | **(1 + N) writes, 0 read** — 1 write danh mục + N write `className`, gộp `:commit` |
| Nhóm mới từ máy khác | poll watermark | 1 read / vòng (rỗng vẫn 1), **nhịp 15 s** ⚡ |

**Phân cấp Trường → Lớp → Nhóm**

Một giáo viên có thể dạy nhiều trường, mỗi trường nhiều lớp. Trang có thanh chọn 3 cấp:

```
🏫 Chọn trường  →  📚 Chọn lớp  →  👥 Bảng chấm điểm của lớp đó
```

- **Dữ liệu**: mỗi nhóm mang sẵn `schoolId/schoolName/classId/className` (denormalized) nên
  lọc theo lớp là **0 read**; danh mục trường/lớp nằm trong **một** document
  `meta/hierarchy` nên mọi thao tác trường/lớp chỉ tốn **1 write**.
- **Tương thích ngược**: nhóm cũ chưa có `schoolId/classId` vẫn hiện bình thường, rơi vào
  *“Chưa phân loại” / “Chưa xếp lớp”*.
- **Mất danh mục không mất dữ liệu**: `TTDB.reconcileHierarchy()` suy ra trường/lớp từ chính
  các nhóm (0 read thêm) khi mở trên máy khác.
- **Nhớ lớp**: `localStorage` khoá `star-race-v1-sel` giữ trường/lớp đang chọn khi tải lại.
- **Đổi tên lớp**: nút ✏️ trên mỗi thẻ lớp. Đổi tên đồng bộ **cả hai nơi** — danh mục
  `meta/hierarchy` và field `className` của mọi nhóm thuộc lớp đó (gộp `:commit`,
  ≤400 write/lần). UI cập nhật lạc quan ngay; ghi lỗi thì tự hoàn tác tên cũ.
- Mọi thao tác (xếp hạng, tìm kiếm, xuất ảnh, đặt lại điểm) **chỉ tác động lên lớp đang chọn**.

**Ba đặc tính được giữ nguyên**

- **UI lạc quan**: bấm là thấy sao ngay, không chờ mạng. Ghi thì gộp 1,2 giây → bấm 10 lần = 1 write.
- **Chỉ 1 listener**: `subscribe()` tự huỷ cái cũ; nhịp poll tự giãn **15 s → 30 s** khi rảnh,
  dừng khi tab ẩn, huỷ khi `pagehide` (kèm `keepalive` để write cuối không bị mất).
- **Fallback Local**: chưa cấu hình Firebase thì vẫn chạy `localStorage` như cũ, kèm nhãn
  *“💾 Chế độ Local”* để giáo viên biết dữ liệu chưa lên mây.

**Tối ưu quota (phase 2025-10-31)**

| | Trước | Sau |
|---|---|---|
| Nhịp poll | 4 s | **15 s** (giãn 30 s khi rảnh) |
| Reads/tiết 45 phút (5 lớp × 6 nhóm) | ≈ 766 | **≈ 211** (−72 %) |
| F5 trong 60 s | 30 reads | **0 read** |
| Lưu cài đặt lớp | ghi đè cả `stars`/`total` ⚠️ | **không ghi** `stars`/`total` |
| Write khi đóng tab | mất (thiếu `keepalive`) | **giữ được** |

> `stars`/`total` là **dẫn xuất** của phép cộng trên server. Ghi chúng trong PATCH cấu hình
> nghĩa là lấy ảnh chụp trên máy này đè lên server — bấm “Lưu cài đặt” ở tab khác sẽ
> **xoá mất điểm** máy kia vừa cộng. Đã chặn ở cả hai lớp (`db.js` và `index.html`).

**Lỗi được báo rõ** (không im lặng): `PERMISSION_DENIED` (rules chưa deploy),
`UNAUTHENTICATED` (phiên hết hạn), `NOT_FOUND` (chưa bật Firestore), `UNAVAILABLE` (mất mạng).

## Đăng nhập / Đăng ký

Trang `index.html` là cửa vào của TeachTool — một card nhỏ giữa màn hình với 2 tab
**Đăng nhập** / **Đăng ký**, chuyển tab mượt, responsive trên điện thoại và máy tính.

- **Đăng ký** chỉ cần 3 trường: tên tài khoản, mật khẩu, xác nhận mật khẩu.
  Không xác minh email, không OTP, không ví.
- **Kiểm tra trùng tên tài khoản** ở cả hai phía:
  - *Client*: dò ngay khi gõ (debounce 380 ms) → hiện “Tên này đã có người dùng rồi”.
  - *Server/lưu trữ*: kiểm tra lại **bên trong khoá độc quyền** ngay trước khi ghi
    (`navigator.locks` ở chế độ local; Firebase Auth tự bảo đảm duy nhất email ở chế độ cloud)
    → chặn hoàn toàn race condition khi 2 tab đăng ký cùng lúc.
- **Mật khẩu không lưu plaintext**: băm `SHA-256` với salt ngẫu nhiên 16 byte
  (Web Crypto API, có bản dự phòng thuần JS) trước khi lưu.
- **Phiên đăng nhập** lưu trong `localStorage` (khoá `tt_session_v1`, hạn 30 ngày).
  `home.html` đọc phiên này: chưa đăng nhập thì tự chuyển về `/`, đã đăng nhập thì
  hiện tên + nút **Đăng xuất** ở header.

### Hai chế độ lưu trữ

| Chế độ | Khi nào | Cách hoạt động |
|---|---|---|
| **Firebase** | `api/config.js` trả về `firebase.apiKey` | Gọi Firebase Auth REST (`identitytoolkit`). Tên tài khoản được ánh xạ thành `<tên>@users.teachtool.app`. Không cần SDK, không cần thêm script ngoài. |
| **Local** (dự phòng) | Chưa đặt biến môi trường | Lưu vào `localStorage` khoá `tt_users_v1`. Trang chạy được ngay, không cần backend. |

Trạng thái đang dùng hiển thị ở chân card. Khi đã có Firebase, chỉ cần đặt biến môi
trường trên Vercel — **không phải sửa code**.

> ⚠️ Chế độ local chỉ phù hợp để thử nghiệm: dữ liệu nằm trong trình duyệt của từng
> máy nên không dùng chung giữa các thiết bị.

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
open index.html

# Hoặc chạy static server (khuyến nghị, để iframe + api/config.js hoạt động)
npx serve .
```

## Deploy

Repo được cấu hình sẵn cho Vercel (static + serverless function). Import repo vào Vercel,
sau đó đặt các biến trong `.env.example` tại **Settings → Environment Variables**.

## Hồ sơ người dùng trên Firestore

Sau khi đăng ký/đăng nhập thành công, `index.html` gọi `TTDB.ensureUserProfile()`
(`js/db.js`) để tạo/cập nhật document `users/{uid}` với 6 field tối thiểu:
`username`, `createdAt`, `updatedAt`, `lastLoginAt`, `plan`, `schemaVersion`.
Dùng `PATCH` + `updateMask` nên không ghi đè dữ liệu cũ khi đăng nhập lại.

> ⚠️ **Bắt buộc:** phải deploy `firestore.rules` thì mới ghi được. Nếu chưa deploy,
> Firestore ở Production mode sẽ trả `403 PERMISSION_DENIED` và không có document nào
> xuất hiện. Xem hướng dẫn chi tiết + cách tự kiểm tra tại
> **[docs/firebase-setup.md](docs/firebase-setup.md)**.

## Ghi chú bảo mật

- `.env` và mọi file chứa private key đã nằm trong `.gitignore`.
- `FIREBASE_SERVICE_ACCOUNT_JSON` chỉ dùng server-side; `api/config.js` **không** trả biến này ra client.
- Firebase Web SDK config (`apiKey`, `projectId`, …) là thông tin công khai theo thiết kế của
  Firebase — bảo vệ dữ liệu bằng **Firestore Security Rules**, không phải bằng cách giấu apiKey.
