# Đối chiếu quota Firestore — bảng điền tay từ Console

Mục đích: **kiểm chứng bằng số thật** những gì báo cáo audit chỉ suy ra từ code.
Báo cáo audit (2026-10-31) ước tính bằng cách đọc `js/db.js`; tài liệu này để bạn
điền số **thật** lấy từ Firebase Console rồi so sánh.

> ⚠️ Không có số nào trong tài liệu này là số đo thật của bạn. Bảng dưới **trống có chủ ý**.
> Mọi con số "ước tính" đều ghi rõ là ước tính.

---

## 1. Bảng cần điền

Mỗi dòng = một ngày. Lấy số từ Console (mục 2), rồi tự tính cột cuối.

| Ngày | reads | writes | deletes | egress (MB) | Số GV hoạt động | reads ÷ GV | % ngưỡng Spark | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| 2026-10-25 |  |  |  |  |  |  |  |  |
| 2026-10-26 |  |  |  |  |  |  |  |  |
| 2026-10-27 |  |  |  |  |  |  |  |  |
| 2026-10-28 |  |  |  |  |  |  |  |  |
| 2026-10-29 |  |  |  |  |  |  |  |  |
| 2026-10-30 |  |  |  |  |  |  |  |  |
| 2026-10-31 |  |  |  |  |  |  |  |  |

**Công thức:**

```
reads ÷ GV        = reads ÷ số giáo viên hoạt động ngày đó
% ngưỡng Spark    = reads ÷ 50.000 × 100
% ngưỡng write    = writes ÷ 20.000 × 100
```

**Ngưỡng gói Spark (miễn phí):**

| Chỉ số | Hạn mức/ngày |
|---|---|
| Document reads | 50.000 |
| Document writes | 20.000 |
| Document deletes | 20.000 |
| Egress | 10 GB/tháng |

---

## 2. Cách lấy số từ Firebase Console

1. Mở <https://console.firebase.google.com> → chọn project **teachtool-aadf1**
2. Menu trái → **Usage and billing** (hoặc **Firestore Database → Usage**)
3. Chọn tab **Firestore** → biểu đồ **Document reads / writes / deletes**
4. Đổi khoảng thời gian sang **Last 7 days**
5. Rê chuột lên từng cột ngày → tooltip hiện số chính xác
6. Ghi vào bảng mục 1

**Lấy egress:** cùng trang, biểu đồ **Network egress** (đơn vị MB/GB).

**Lấy số giáo viên hoạt động:** không có sẵn trong Console. Ba cách:

- **Cách A (nhanh nhất):** Firebase Console → **Authentication** → tab **Users** →
  cột **Last sign-in**. Đếm số user đăng nhập trong ngày đó.
- **Cách B:** Firestore → collection `users` → mở vài document → xem field
  `lastLoginAt`. Đếm thủ công (tốn 1 read/document — đừng làm với 200 user).
- **Cách C:** dùng script `tools/quota-report.js` (mục 3) rồi suy ra:
  `GV ≈ reads ÷ 1055` (xem mục 4).

> 💡 Nếu bạn chỉ có 1–2 giáo viên đang dùng thử, hãy ghi rõ vào cột Ghi chú.
> Khi đó `reads ÷ GV` sẽ rất lớn và **không** phản ánh tải thật của một lớp học.

---

## 3. Cách lấy số tự động (nếu có service account)

```bash
node tools/quota-report.js --key=.secrets/sa.json --days=7
```

Xuất CSV để dán vào bảng trên:

```bash
node tools/quota-report.js --key=.secrets/sa.json --days=7 --out=quota.csv
```

Cách tạo service account (chỉ quyền ĐỌC, không đụng dữ liệu học sinh):

1. <https://console.cloud.google.com> → chọn project **teachtool-aadf1**
2. **IAM & Admin → Service Accounts → Create service account**
3. Tên `quota-reader` → **Create and continue**
4. Role: **Monitoring Viewer** (`roles/monitoring.viewer`) → **Continue → Done**
5. Bấm vào account → tab **Keys** → **Add key → Create new key → JSON** → tải về
6. Đặt file vào `.secrets/sa.json` (đã gitignore) — **tuyệt đối không commit**

> 🔒 File key này cho phép đọc metric của project. Không chia sẻ, không dán vào chat,
> không đưa vào repo. `.gitignore` đã chặn `serviceAccount*.json`, `*-key.json`, `.secrets/`.

---

## 4. Số ước tính để so sánh

Đây là **ước tính từ code + đo bằng emulator**, không phải số thật của bạn.
Dùng làm mốc để biết số Console là cao hay thấp bất thường.

Giả định: 1 giáo viên, 5 lớp × 6 nhóm = **30 nhóm**, 30 học sinh/nhóm,
1 tiết 45 phút, 2 lần F5/tiết, 40 lần bấm sao/tiết.

| Thao tác | reads | writes | Ghi chú |
|---|---|---|---|
| Mở trang lạnh | **30** | 0 | 1 read/nhóm |
| Mở trang, cache còn hạn (<60 s) | **0** | 0 | sessionStorage |
| Đọc danh mục trường/lớp | **1** | 0 | 1 document `meta/hierarchy` |
| 1 vòng poll, không đổi gì | **1** | 0 | truy vấn rỗng vẫn tính 1 |
| 40 lần bấm +1 sao | **0** | **1** | gộp 1,2 s + `increment` |
| Lưu cài đặt 6 nhóm | 0 | **6** | 1 write/nhóm |
| Đổi tên lớp (6 nhóm) | 0–1 | **7** | 1 danh mục + 6 nhóm |
| Thêm 1 học sinh | 0 | **1** | `appendMissingElements` |
| Xoá 1 học sinh | 0 | **2** | PATCH + increment âm `total` |

**Một tiết 45 phút:**

| | reads/tiết | reads/ngày (5 tiết) | GV tối đa trên Spark |
|---|---|---|---|
| Trước tối ưu (poll 4 s, không cache) | 766 | 3.830 | **13** |
| Sau tối ưu (poll 15 s, cache 60 s) | **211** | **1.055** | **47** |

**Egress đo được:** 89,2 KB cho lần mở trang lạnh 30 nhóm × 30 học sinh
≈ **3,0 KB/nhóm** ≈ **101 B/học sinh**.

---

## 5. Cách đọc kết quả

| Hiện tượng | Nghĩa là | Nên làm |
|---|---|---|
| `reads ÷ GV` ≈ 1.000–1.200 | Đúng như ước tính | Không cần làm gì |
| `reads ÷ GV` ≈ 3.500–4.000 | Vẫn ở nhịp poll cũ (4 s) hoặc cache không chạy | Kiểm tra `POLL_FAST_MS` và `sessionStorage` có bị chặn |
| `reads ÷ GV` > 5.000 | Có nguồn read khác (tính năng khác, hoặc nhiều tab/1 GV) | Xem cột Ghi chú, thử đóng bớt tab |
| `% ngưỡng Spark` > 80% | Sắp vượt | Giảm poll xuống 30 s, hoặc lên Blaze |
| `writes` cao bất thường | Có vòng lặp ghi, hoặc nhiều người sửa cùng lúc | Kiểm tra `syncGroup` có bị gọi lặp |
| `egress` cao | Document phình to (base64 ảnh trong document) | Xem lại nếu có lưu ảnh |

---

## 6. Đo trực tiếp trong ứng dụng (không cần Console)

Bộ đếm có sẵn trong `js/db.js`, **tắt mặc định**. Bật bằng một trong hai cách:

```
https://teachtool-psi.vercel.app/features/star-race?debug=quota
```

hoặc trong Console trình duyệt:

```js
localStorage.setItem('tt_quota', '1');   // rồi tải lại trang
localStorage.removeItem('tt_quota');     // tắt lại
```

Khi bật, góc dưới-trái hiện bảng: **reads / writes / KB / số vòng poll / cache hit**,
kèm bảng chi tiết theo từng thao tác (`open`, `poll`, `star`, `group-save`…).
Nút **Reset** đưa về 0 để đo một thao tác riêng.

Đọc số bằng code:

```js
TTDB.quota.snapshot()   // { reads, writes, deletes, kb, polls, cacheHits, ... }
TTDB.quota.reset()
TTDB.quota.enabled()
```

> Bộ đếm đếm **document**, không phải request — đúng đơn vị Firestore tính tiền.
> Một truy vấn không khớp gì vẫn tính 1 read, và bộ đếm cũng tính 1.

**Cách dùng để kiểm chứng:** mở trang với `?debug=quota`, bấm **Reset**, rồi thực hiện
đúng một thao tác (vd bấm +1 sao 10 lần). Số hiện ra phải khớp bảng ở mục 4.
Nếu khớp → mô hình ước tính đúng với dữ liệu thật của bạn.

---

## 7. Ghi chú về độ chính xác

- **Cloud Monitoring trễ 2–5 phút** và tổng hợp theo cửa sổ 60 s → số của "hôm nay"
  luôn thấp hơn thực tế.
- **Console làm tròn** ở mức hàng nghìn khi xem biểu đồ; rê chuột để lấy số chính xác.
- **Bộ đếm trong app** đếm phía client: nếu request bị huỷ giữa đường (mất mạng),
  nó vẫn có thể đã đếm. Chênh lệch thường < 1 %.
- **Số "GV ước tính"** chỉ là quy đổi, không phải số người dùng thật.
