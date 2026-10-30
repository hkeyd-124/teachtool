# Sửa lỗi: đăng ký xong nhưng Firestore không có document

Tài liệu này ghi lại **nguyên nhân gốc** của lỗi "tạo tài khoản mới nhưng Firestore
không xuất hiện document/field nào", cách đã sửa trong code, và **các bước bạn cần
làm trong Firebase Console** để dữ liệu thực sự được ghi.

---

## 1. Nguyên nhân gốc — có HAI lỗi, không phải một

### Lỗi 1 — Code không hề gọi Firestore (đã sửa)

`index.html` trước đây chỉ làm đúng hai việc khi đăng ký:

1. Gọi Firebase **Auth** REST (`accounts:signUp`) → tạo tài khoản trong
   **Authentication**.
2. Lưu phiên vào `localStorage`.

Nó **không hề** gọi Firestore. Vì vậy:

- Tab **Authentication** có user mới ✅
- Tab **Firestore** trống hoàn toàn ❌

Đây là lý do phổ biến nhất khiến người ta tưởng "Firebase không lưu dữ liệu" —
thực ra **Auth và Firestore là hai dịch vụ tách biệt**. Tạo user trong Auth
**không** tự sinh document trong Firestore.

Ngoài ra `js/db.js` có một lỗi nhỏ khiến nó không nhận ra phiên đăng nhập:
`index.html` ghi khoá `exp` (hạn phiên) còn `db.js` lại đọc `ex` → luôn coi là
hết hạn. Đã sửa để chấp nhận cả hai.

### Lỗi 2 — `firestore.rules` chưa được deploy (BẠN cần làm)

Đây là lỗi chặn cuối cùng. Firestore mới tạo ở **Production mode** mặc định
**từ chối mọi truy cập**:

```
allow read, write: if false;
```

File `firestore.rules` trong repo là **bản thiết kế**, không tự động áp dụng.
Nếu chưa deploy, mọi lệnh ghi đều trả về:

```json
{ "error": { "code": 403, "status": "PERMISSION_DENIED",
             "message": "Missing or insufficient permissions." } }
```

**Đã kiểm chứng thực tế** trên project `teachtool-aad1e` ngày 31/10/2026:
tạo tài khoản qua Auth REST thành công (uid `zahe6yM4aXSC1tJ3ny1KNkwnCeo2`),
nhưng `GET` và `PATCH` tới `users/{uid}` đều trả **403 PERMISSION_DENIED**.

> **Phân biệt quan trọng:** nếu Firestore **chưa được tạo**, lỗi sẽ là
> `404 NOT_FOUND` hoặc `FAILED_PRECONDITION`, **không phải** 403.
> Nhận 403 nghĩa là **database đã tồn tại**, chỉ có rules đang chặn.
> Vậy bạn **không cần** tạo lại database — chỉ cần deploy rules.

---

## 2. Code đã sửa gì

### `js/db.js`

Thêm hàm `ensureUserProfile(username)` — tạo/cập nhật `users/{uid}`:

| Trường hợp | Thao tác | Chi phí |
|---|---|---|
| Document **đã có** | `PATCH` + `updateMask` chỉ 2 field `updatedAt`, `lastLoginAt` | 1 read + 1 write |
| Document **chưa có** | `PATCH` + `updateMask` đủ 6 field tối thiểu | 1 read + 1 write |

Dùng `PATCH` + `updateMask` (tương đương `setDoc(..., { merge: true })` của SDK)
nên **không bao giờ ghi đè** `username`, `createdAt`, `plan` của lần đăng nhập
trước, và **không xoá** field lạ do sau này thêm vào.

Sáu field tối thiểu khi tạo mới:

```json
{
  "username":      "coNga",
  "createdAt":     "2026-10-31T01:20:00.000Z",
  "updatedAt":     "2026-10-31T01:20:00.000Z",
  "lastLoginAt":   "2026-10-31T01:20:00.000Z",
  "plan":          "free",
  "schemaVersion": 1
}
```

### `index.html`

- Nạp lớp truy cập chung: `<script src="/js/db.js"></script>` — **không** tự
  viết lại logic Firestore riêng.
- Thêm `finishAuth(res)` dùng chung cho **cả** đăng ký và đăng nhập:
  lưu phiên → `TTDB.init()` → `TTDB.ensureUserProfile()`.
- Thêm `profileErrText(err)` dịch mã lỗi Firestore thành câu tiếng Việt cụ thể
  thay vì im lặng:

| Mã lỗi | Thông báo cho người dùng |
|---|---|
| `PERMISSION_DENIED` | "Firestore TỪ CHỐI ghi dữ liệu… cần deploy firestore.rules" |
| `UNAUTHENTICATED` / 401 | "Phiên đăng nhập không hợp lệ… đăng nhập lại" |
| `NOT_FOUND` / 404 | "Chưa bật Firestore… Create database" |
| `FAILED_PRECONDITION` | "Firestore chưa sẵn sàng…" |

Nếu ghi hồ sơ thất bại, người dùng **vẫn vào được `/home`** (phiên đã hợp lệ)
nhưng thấy thông báo lỗi rõ ràng — không còn im lặng.

---

## 3. Việc BẠN cần làm — deploy rules (bắt buộc)

### Cách A — dán trực tiếp vào Console (nhanh nhất, 1 phút)

1. Mở https://console.firebase.google.com/project/teachtool-aad1e/firestore/rules
2. Xoá toàn bộ nội dung đang có
3. Mở file `firestore.rules` trong repo, **copy toàn bộ** rồi dán vào
4. Bấm **Publish**
5. Đợi ~30 giây

### Cách B — Firebase CLI (khuyến nghị về lâu dài)

```bash
npm i -g firebase-tools
firebase login
cd teachtool
firebase use teachtool-aad1e
firebase deploy --only firestore:rules,firestore:indexes
```

Cần thêm `firebase.json` ở gốc repo:

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
```

---

## 4. Cách tự kiểm tra sau khi deploy rules

1. Mở https://teachtool-psi.vercel.app
2. Đăng ký một tài khoản mới (ví dụ `gvtest01` / `matkhau123`)
3. Vào https://console.firebase.google.com/project/teachtool-aad1e/firestore/data
4. Phải thấy:

```
users
 └─ <uid 28 ký tự>
     ├─ username:      "gvtest01"
     ├─ createdAt:     31/10/2026 ...
     ├─ updatedAt:     31/10/2026 ...
     ├─ lastLoginAt:   31/10/2026 ...
     ├─ plan:          "free"
     └─ schemaVersion: 1
```

Nếu vẫn trống, mở **DevTools → Console** và xem thông báo lỗi màu đỏ — code
giờ đã in rõ mã lỗi Firestore.

### Kiểm tra nhanh bằng curl

```bash
# 1. Lấy idToken
curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyCNwfGqZuZBd-xClkSgOGcRVijRtgubMFA" \
  -H "Content-Type: application/json" \
  -d '{"email":"test01@users.teachtool.app","password":"matkhau123","returnSecureToken":true}'

# 2. Dùng idToken ở trên để đọc hồ sơ
curl -s "https://firestore.googleapis.com/v1/projects/teachtool-aad1e/databases/(default)/documents/users/<uid>" \
  -H "Authorization: Bearer <idToken>"
```

- `200` + có `fields` → rules đã đúng ✅
- `403 PERMISSION_DENIED` → rules **chưa** deploy ❌
- `404 NOT_FOUND` → rules OK nhưng document chưa được tạo

---

## 5. Checklist cấu hình Firebase

| # | Việc | Trạng thái |
|---|---|---|
| 1 | Tạo project `teachtool-aad1e` | ✅ đã có |
| 2 | Bật **Authentication → Email/Password** | ✅ đã có (đăng ký chạy được) |
| 3 | Tạo **Firestore Database** | ✅ đã có (lỗi là 403, không phải 404) |
| 4 | Thêm domain `teachtool-psi.vercel.app` vào **Authorized domains** | ✅ đã có |
| 5 | Đặt 6 biến `FIREBASE_*` trên Vercel | ✅ đã có (`/api/config.js` trả `cloud: true`) |
| 6 | **Deploy `firestore.rules`** | ❌ **CÒN THIẾU — làm mục 3** |
| 7 | Deploy `firestore.indexes.json` | ⬜ tuỳ chọn (hiện chưa cần composite index) |

---

## 6. Lưu ý bảo mật

- `apiKey` trong `/api/config.js` là **khoá công khai theo thiết kế của Firebase**
  — nó chỉ định danh project, không cấp quyền gì. Quyền do **rules** quyết định.
- **Tuyệt đối không** đưa `serviceAccount.json` (private key) lên Vercel dưới
  dạng biến `NEXT_PUBLIC_*` / `VITE_*` hay bất kỳ biến nào lộ ra client.
- Rules hiện tại: mỗi user chỉ đọc/ghi `/users/{uid}` của chính mình, mọi đường
  dẫn khác bị từ chối. Không có `allow read, write: if true` ở bất kỳ đâu.
