# Deploy `firestore.rules` — hướng dẫn từng bước

Tài liệu này chỉ nói về **một việc**: đưa file `firestore.rules` trong repo lên
Firebase làm rules đang chạy thật.

Nếu bạn từng thấy lỗi khi dán rules, hoặc thấy banner trong app

> ⚠️ Danh mục trường/lớp đang lưu tạm trên máy này — deploy firestore.rules để đồng bộ

thì đọc mục 1 và mục 2.

---

## 1. Hai nguyên nhân hay gặp nhất

### 1.1 Dán từ trang GitHub → dính ký tự lạ

Trang `github.com/.../blob/...` là trang **HTML có trang trí**, không phải file.
Nếu bạn bôi đen rồi copy từ đó, có thể dính thêm số dòng, ký tự ẩn, hoặc các
đoạn `request.resource.data` bị một số tiện ích mở rộng biến thành link.

**Cách đúng:** dùng link **RAW**. Trang raw chỉ trả về đúng nội dung file, không
HTML, không số dòng, không link.

```
https://raw.githubusercontent.com/hkeyd-124/teachtool/main/firestore.rules
```

Mở link đó → `Ctrl+A` → `Ctrl+C` → dán vào Console. Nếu bạn dùng terminal:

```bash
# macOS
curl -sL https://raw.githubusercontent.com/hkeyd-124/teachtool/main/firestore.rules | pbcopy

# Windows PowerShell
curl.exe -sL https://raw.githubusercontent.com/hkeyd-124/teachtool/main/firestore.rules | Set-Clipboard
```

Cách này **không thể** sinh lỗi copy: nội dung vào clipboard là byte thật của file.

### 1.2 Rules đang chạy là bản CŨ hơn trên repo

Đây là nguyên nhân âm thầm nhất. Rules đã deploy **không tự cập nhật** khi bạn
push code lên GitHub.

Triệu chứng: dữ liệu nhóm học sinh / điểm sao vẫn lưu bình thường, nhưng tên
trường và tên lớp **không đồng bộ giữa các máy** — vì document `meta/hierarchy`
nằm trong danh sách **từ chối** của bản rules cũ, nên app tự chuyển sang lưu
danh mục ở `localStorage` và hiện banner vàng.

Cách nhận biết chắc chắn: mở **DevTools → Console**, tìm dòng

```
[star-race] meta/hierarchy bị 403 — đang lưu danh mục trường/lớp tạm trên máy...
```

Nếu thấy dòng này thì **100% rules trên Firebase chưa có khối `meta/hierarchy`** →
làm mục 2.

---

## 2. Deploy — chọn một trong hai cách

### Cách A — dán trực tiếp vào Console (1 phút, không cần cài gì)

1. Mở https://console.firebase.google.com/project/teachtool-aad1e/firestore/rules
2. Bấm vào ô soạn rules, `Ctrl+A` rồi `Delete` — **xoá sạch** nội dung cũ
3. Lấy nội dung sạch bằng link raw ở mục 1.1, rồi dán vào
4. Kiểm tra nhanh trước khi bấm: dòng đầu phải là `rules_version = '2';`,
   dòng cuối phải là `}`. Không được có số dòng ở đầu, không được có `[...](...)`.
5. Bấm **Publish**. Chờ ~30 giây.
6. Quay lại app, `Ctrl+Shift+R` (hard reload). Banner vàng phải biến mất.

### Cách B — Firebase CLI (khuyến nghị về lâu dài)

Repo đã có sẵn `firebase.json`, nên chỉ cần:

```bash
npm i -g firebase-tools
firebase login
cd teachtool
firebase use teachtool-aad1e
firebase deploy --only firestore:rules
```

Kết quả mong đợi:

```
✔  firestore: released rules firestore.rules to cloud.firestore
✔  Deploy complete!
```

CLI là cách duy nhất **không thể** sai do copy-paste, và nó báo lỗi cú pháp
ngay tại máy bạn thay vì để bạn phát hiện lúc dùng app.

---

## 3. Kiểm tra sau khi deploy (bắt buộc)

### 3.1 Banner trong app

Mở https://teachtool-psi.vercel.app → vào Star Race. Banner vàng phải **mất**.
Nếu vẫn còn, hard reload một lần nữa rồi mở Console xem mã lỗi.

### 3.2 Tạo một trường mới thử

Vào phần chọn trường/lớp → tạo một trường mới → **F5**.
Nếu trường mới **vẫn còn** sau khi tải lại, và mở trên máy khác cũng thấy →
rules đã đúng.

### 3.3 Kiểm tra bằng curl (cho người thích chắc chắn)

```bash
# 1. Lấy idToken
curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"email":"test01@users.teachtool.app","password":"matkhau123","returnSecureToken":true}'

# 2. Đọc document meta/hierarchy (thay <uid> và <idToken>)
curl -s \
  "https://firestore.googleapis.com/v1/projects/teachtool-aad1e/databases/(default)/documents/users/<uid>/features/star-race/meta/hierarchy" \
  -H "Authorization: Bearer <idToken>"
```

| Kết quả | Nghĩa |
|---|---|
| `200` + có `fields` | Rules đúng, đã có danh mục ✅ |
| `404 NOT_FOUND` | Rules đúng, mới chưa tạo danh mục — bình thường ✅ |
| `403 PERMISSION_DENIED` | Rules **cũ**, chưa có `meta/hierarchy` ❌ |
| `400 INVALID_ARGUMENT` + "Error compiling rules" | Rules dán vào **sai cú pháp** ❌ |

---

## 4. Ba việc đã sửa trong v3 (để bạn biết mình đang chạy bản nào)

| # | Trước | Vấn đề | v3 |
|---|---|---|---|
| 1 | `total` chênh tối đa ±1000 mỗi write | Chặn nhầm **"Đặt lại điểm"** với nhóm đã tích > 1000 sao (403) | Đã bỏ |
| 2 | `schools.size() >= 1` | Chặn nhầm thao tác dọn/xoá danh mục | Đã bỏ |
| 3 | — | Repo thiếu `firebase.json` nên lệnh deploy CLI thất bại | Đã thêm |

Nhận biết bạn đang chạy v3: mở đầu file có dòng
`// TeachTool — Firestore Security Rules  (v3 — 2026-11-01)`.

---

## 5. Lưu ý bảo mật

- `apiKey` trong `/api/config.js` là **khoá công khai theo thiết kế của Firebase**
  — nó chỉ định danh project, không cấp quyền gì. Quyền do **rules** quyết định.
- **Tuyệt đối không** đưa `serviceAccount.json` (private key) lên Vercel dưới dạng
  biến `NEXT_PUBLIC_*` / `VITE_*` hay bất kỳ biến nào lộ ra client.
- Rules hiện tại: mỗi user chỉ đọc/ghi `/users/{uid}` của chính mình, mọi đường dẫn
  khác bị từ chối. Không có `allow read, write: if true` ở bất kỳ đâu.
