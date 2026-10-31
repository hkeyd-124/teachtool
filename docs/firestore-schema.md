# Thiết kế dữ liệu Firestore cho TeachTool

Tài liệu này mô tả cấu trúc dữ liệu đã chọn cho TeachTool, so sánh ba phương án
lồng dữ liệu, và ước tính hạn ngạch (quota) cho gói **Spark**.

Mục tiêu: **một giáo viên dùng 1 tiết học (40 phút, 6 nhóm × 5 học sinh) không
bao giờ chạm trần Spark**, kể cả khi bấm cộng star liên tục.

---

## 1. Mô hình nghiệp vụ

```
User (giáo viên)
  └─ Tính năng (feature) — vd: star-race
       └─ Nhóm (group) — tên nhóm, biểu tượng, màu
            └─ Học sinh (student) — tên
                 └─ Số star
```

Quan hệ: **1 user → nhiều feature → nhiều group → nhiều student**. Số star gắn
với **từng học sinh**, và mỗi nhóm có **tổng** star riêng.

---

## 2. Ba phương án lồng dữ liệu

### Phương án A — Subcollection lồng sâu

```
users/{uid}/features/{featureId}/groups/{groupId}
users/{uid}/features/{featureId}/groups/{groupId}/students/{sid}
    { name, stars }
```

**Ưu:** mỗi học sinh là một document riêng → ghi star của một em chỉ chạm 1 doc nhỏ.
**Nhược:** mở trang phải đọc **1 + 6 + 30 = 37 reads**. Xoá nhóm = **6 writes**
(1 nhóm + 5 học sinh). Thêm học sinh mới = 1 write **mới** nhưng phải đọc lại
collection để render.

### Phương án B — Mỗi nhóm là 1 document chứa mảng `students` ✅ **CHỌN**

```
users/{uid}/features/{featureId}/groups/{groupId}
    { name, order, emoji, color,
      students: [{ id, name }, ...],
      stars:    { studentId: number, ... },
      total:    number,
      createdAt, updatedAt }
```

**Ưu:**
- Mở trang = **N reads** (N = số nhóm). Với 6 nhóm = **6 reads** (so với 37 của A).
- Xoá nhóm = **1 write** (so với 6 của A).
- Star nằm trong **map** `stars`, nên cộng star vẫn dùng được `increment` trên
  đúng một field → **1 write, 0 read**.
- Không có trần "1 write/giây/document" vì mỗi nhóm là một document riêng.

**Nhược:** cập nhật đồng thời cùng một nhóm từ hai máy sẽ ghi đè phần `students`
(chấp nhận được: cấu hình lớp do 1 giáo viên quản lý, thao tác hiếm).

### Phương án C — Một document duy nhất cho mỗi (user, feature)

```
users/{uid}/features/{featureId}
    { groups: [ { id, name, students:[...], stars:{...}, total } ] }
```

**Ưu:** mở trang chỉ **1 read**.
**Nhược:**
- Mỗi lần cộng star phải ghi một phần của document lớn → egress tăng mạnh
  (~0,9 KB/doc × 60 lần = **~54 KB** chỉ để cộng 60 star, so với ~2 KB của B).
- **Chạm trần 1 write/giây/document** khi giáo viên bấm nhanh hoặc 2 thiết bị
  cùng dùng → mất star thật.
- Khi lớp lớn (12 nhóm × 20 em) document phình to, gần trần 1 MiB.

### Bảng so sánh cho **một tiết 40 phút** (6 nhóm × 5 em, 60 lần bấm star)

| Chỉ số | A (subcollection) | **B (chọn)** | C (1 doc) |
|---|---|---|---|
| Reads khi mở trang | 37 | **7** | 1 |
| Reads cả tiết | ~164 | **~72** | ~62 |
| Writes cả tiết | ~71 | **~61** | ~60 |
| Writes khi xoá 1 nhóm | 6 | **1** | 1 |
| Egress cả tiết | ~33 KB | **~65 KB** | ~500 KB |
| Rủi ro trần 1 write/s/doc | Không | **Không** | **Có** |

**Kết luận:** B cân bằng nhất — reads gần bằng C nhưng không có trần ghi,
và tiết kiệm egress ~8 lần so với C.

---

## 3. Cây collection

```
users/{uid}                                    ← hồ sơ giáo viên
  username, createdAt, updatedAt, lastLoginAt,
  plan, schemaVersion

  features/{featureId}                         ← metadata tính năng
    title, createdAt

    groups/{groupId}                           ← ★ một nhóm = một document
      name, order, createdAt, updatedAt,
      emoji, color,
      students: [{ id, name }],
      stars:    { studentId: number },
      total:    number
```

Với `featureId = "star-race"`, đường dẫn đầy đủ:

```
users/{uid}/features/star-race/groups/{groupId}
```

---

## 4. Ý nghĩa từng field

### `users/{uid}`

| Field | Kiểu | Ghi chú |
|---|---|---|
| `username` | string | Tên tài khoản. **Bất biến** sau khi tạo (rules chặn đổi). |
| `createdAt` | timestamp | Thời điểm tạo. **Bất biến.** |
| `updatedAt` | timestamp | Cập nhật mỗi lần ghi. |
| `lastLoginAt` | timestamp | Cập nhật mỗi lần đăng nhập. |
| `plan` | string | `free` / `pro`. **Bất biến từ client** (chống tự nâng gói). |
| `schemaVersion` | int | Phiên bản schema, hiện là `1`. |

### `groups/{groupId}`

| Field | Kiểu | Giới hạn | Ghi chú |
|---|---|---|---|
| `name` | string | ≤ 60 ký tự | Tên nhóm. |
| `order` | int | 1..1000 | Thứ tự hiển thị. |
| `emoji` | string | ≤ 16 ký tự | Biểu tượng nhóm. |
| `color` | string | `#RRGGBB` | Màu chủ đạo. |
| `students` | array<map> | ≤ 200 phần tử | Mảng `{ id, name }`. **Không index** (xem mục 8). |
| `stars` | map<string,int> | ≤ 200 entry, 0..100000 | `studentId → số star`. **Không index.** |
| `total` | int | 0..100000 | Tổng star của nhóm. Ghi bằng `increment`. |
| `createdAt` | timestamp | — | **Bất biến.** |
| `updatedAt` | timestamp | — | Đổi mỗi lần ghi. |

---

## 5. Document mẫu

### `users/{uid}`

```json
{
  "name": "projects/teachtool-aad1e/databases/(default)/documents/users/xlsvaMZstDbqHURGPY7bIf69xAo2",
  "fields": {
    "username":      { "stringValue": "co_nga" },
    "createdAt":     { "timestampValue": "2026-10-31T09:12:44.120Z" },
    "updatedAt":     { "timestampValue": "2026-10-31T09:12:44.120Z" },
    "lastLoginAt":   { "timestampValue": "2026-10-31T09:12:44.120Z" },
    "plan":          { "stringValue": "free" },
    "schemaVersion": { "integerValue": "1" }
  }
}
```

### `users/{uid}/features/star-race/groups/g_abc123xyz`

```json
{
  "name": "projects/teachtool-aad1e/databases/(default)/documents/users/xlsva.../features/star-race/groups/g_abc123xyz",
  "fields": {
    "name":       { "stringValue": "Sư Tử" },
    "order":      { "integerValue": "1" },
    "emoji":      { "stringValue": "🦁" },
    "color":      { "stringValue": "#FF6B6B" },
    "createdAt":  { "timestampValue": "2026-10-31T09:20:00.000Z" },
    "updatedAt":  { "timestampValue": "2026-10-31T09:47:12.480Z" },
    "students": {
      "arrayValue": {
        "values": [
          { "mapValue": { "fields": {
              "id":   { "stringValue": "s_a1b2c3d4e5" },
              "name": { "stringValue": "An" } } } },
          { "mapValue": { "fields": {
              "id":   { "stringValue": "s_f6g7h8i9j0" },
              "name": { "stringValue": "Bình" } } } }
        ]
      }
    },
    "stars": {
      "mapValue": { "fields": {
        "s_a1b2c3d4e5": { "integerValue": "7" },
        "s_f6g7h8i9j0": { "integerValue": "4" }
      } }
    },
    "total": { "integerValue": "11" }
  }
}
```

---

## 6. Chi phí từng thao tác

> 💡 **Số liệu ở bảng này là ĐO THẬT** bằng một emulator Firestore REST chạy trên
> Playwright (đếm đúng từng document bị đọc/ghi, semantics `updateMask` và
> `increment` được mô phỏng đúng). Xem mục 11 để biết cách đo lại.

| Thao tác | Reads | Writes | Payload | Cách làm |
|---|---|---|---|---|
| Mở trang — cache **trống** | **N + 1** | 0 | ~2,2 KB/nhóm | `runQuery` 1 lần + 1 read `meta/hierarchy` |
| Mở trang — cache **còn hạn** (< 60 s) | **0** | 0 | 0 | Đọc `sessionStorage` (⚡ việc 3) |
| **Cộng 1 star** | **0** | **1** (gộp) | ~45 B/field | `increment` trên `stars.<sid>` + `total` |
| Cộng 40 star liên tiếp | 0 | **1** | ~200 B | Gộp trong 1,2 s → 1 commit |
| Thêm 1 học sinh | 0 | 1 | ~120 B | `appendMissingElements` trên `students` |
| **Xoá 1 học sinh** | **0** | **2** (1 commit) | ~700 B | PATCH `students` + xoá `stars.<sid>` (**cùng commit** với `increment` âm cho `total`) |
| Thêm 1 nhóm | 0 | 1 | ~250 B | `PATCH` tạo document |
| Xoá 1 nhóm | 0 | **1** | 0 | Xoá document (học sinh đi theo) |
| Đổi tên nhóm | 0 | 1 | ~80 B | `PATCH` + `updateMask=name` |
| Tạo trường / tạo lớp | **0–1** | 1 | ~0,3 KB | Cache `meta` 30 s (⚡ việc 3) |
| **Đổi tên lớp** (N nhóm) | **0** | **1 + N** | ~0,3 KB + 60 B/nhóm | `renameClassEverywhere()`: 1 write meta + N write `className`, gộp `:commit` |
| Lưu cài đặt lớp (6 nhóm) | 0 | 6 | ~3 KB | 1 write/nhóm; **KHÔNG còn ghi `stars`/`total`** (⚡ việc 1) |
| **1 vòng poll, không đổi gì** | **1** | 0 | ~0 B | Watermark `updatedAt > mốc` |
| 1 vòng poll, k document đổi | k | 0 | ~2,2 KB × k | Gộp vào cache |

**Không còn thao tác nào tốn read để lấy số star** — UI đã biết sẵn từ cache.

---

## 7. Ước tính quota — 1 giáo viên, 5 lớp × 6 nhóm, 1 tiết 45 phút

Giả định: **30 nhóm**, 30 học sinh/nhóm; giáo viên bấm **40 lần** cộng star (gộp còn
~1 write); tải lại trang **2 lần** trong tiết; poll realtime suốt tiết; 1 tab.

| Hạng mục | Reads (cache ấm) | Writes |
|---|---|---|
| Mở trang (cache trống, N=30) | 31 | 0 |
| Tải lại 2 lần trong 60 s (cache) | **0** | 0 |
| 40 lần bấm star (gộp 1,2 s) | 0 | ~1 |
| **Poll 15 s** × 180 vòng | **180** | 0 |
| **TỔNG** | **≈ 211** | **≈ 1** |

**So với trước khi tối ưu (poll 4 s):**

| | Poll 4 s (cũ) | Poll 15 s (mới) | Giảm |
|---|---|---|---|
| Poll trong tiết | 675 | **180** | **−73 %** |
| Tải lại 2 lần | 60 | **0** | **−100 %** |
| **Tổng reads/tiết** | **≈ 766** | **≈ 211** | **−72 %** |

> Số **180 reads** cho vòng poll vẫn là khoản chi lớn nhất — nhưng đây là cái giá
> của việc đồng bộ nhiều thiết bị. Nếu chỉ dùng 1 máy, có thể đóng tab sau tiết.

---

## 8. So với hạn ngạch Spark

| Hạn ngạch Spark | Giới hạn | 1 tiết dùng | Số tiết tối đa / ngày |
|---|---|---|---|
| Document reads | 50.000 / ngày | ≈ 107 | **≈ 467 tiết** |
| Document writes | 20.000 / ngày | ≈ 66 | **≈ 303 tiết** ← nút thắt |
| Lưu trữ | 1 GiB | ≈ 12 KB / giáo viên | **≈ 85.000 giáo viên** |
| Egress | 10 GiB / tháng | ≈ 71 KB | ≈ 147.000 tiết |

**Diễn giải:**
- **Writes là hạn ngạch chặn trước**, ở mức ~300 tiết/ngày cho **toàn bộ project**.
- Một giáo viên dạy 5 tiết/ngày chỉ dùng **1,6 %** hạn ngạch write/ngày.
- Một trường 30 giáo viên × 5 tiết = ~10.000 write/ngày = **50 %** hạn ngạch — vẫn trong Spark.
- Lưu trữ và egress gần như không đáng lo.

**Nếu cần vượt:** nâng lên Blaze, hoặc tăng `COALESCE_MS` từ 1200 → 2000 ms
trong `js/db.js` (giảm ~30 % writes, đổi lại phản hồi chậm hơn một chút).

---

## 9. Ràng buộc kỹ thuật

### Trần 1 MiB/document

Với 200 học sinh (giới hạn trong rules):

```
students: 200 × ~30 B  ≈  6 KB
stars   : 200 × ~25 B  ≈  5 KB
metadata               ≈  0,3 KB
───────────────────────────────
Tổng                   ≈ 11,3 KB
```

**Còn xa 1 MiB ~90 lần.** Ngay cả khi tên học sinh dài 40 ký tự (tiếng Việt UTF-8
~80 B) thì vẫn chỉ ~25 KB. **Không có nguy cơ chạm trần.**

### Trần 1 write/giây/document

- Mỗi **nhóm** là một document riêng → 6 nhóm = 6 document khác nhau.
- Trong một commit, nhiều `fieldTransforms` trên **cùng một document** vẫn chỉ
  tính **1 write** và **không** vi phạm trần (trần áp cho số *commit*, không phải
  số *field transform*).
- Nếu backend trả `ABORTED` (vượt trần), `js/db.js` **tự thử lại với backoff**
  250 → 500 → 1000 → 2000 ms. Star không bị mất.

### Số field index

`students` và `stars` **bị tắt index** trong `firestore.indexes.json`
(`fieldOverrides` với `indexes: []`). Lý do:

- Tránh giới hạn **20.000 index entry / document** (một lớp 200 em sẽ sinh
  hàng nghìn entry nếu index mọi phần tử mảng).
- Giảm chi phí mỗi lần ghi star: không phải cập nhật chỉ mục.
- Không truy vấn nào của app lọc theo `students` hay `stars` — chỉ đọc cả document.

---

## 10. Luồng dữ liệu thực tế của trang star-race

Trang `features/star-race/index.html` **không tự gọi Firestore** — mọi thao tác đi qua
`js/db.js` (`window.TTDB`). Đây là hợp đồng giữa UI và lớp dữ liệu:

| Thao tác trên UI | Hàm được gọi | Reads | Writes | Ghi chú |
|---|---|---|---|---|
| Mở trang | `TTDB.init()` → `TTDB.subscribe("star-race", cb)` | N (N = số nhóm) | 0 | 1 listener duy nhất, tự huỷ khi `pagehide` |
| Cập nhật từ máy khác | poll watermark `updatedAt > mốc` | 1 / vòng (0 nếu không đổi) | 0 | nhịp 4 s → 15 s khi rảnh; dừng khi tab ẩn |
| Bấm ⭐ +1 / ➖ | `TTDB.addStar()` / `removeStar()` | **0** | **1** (gộp 1,2 s) | `FieldTransform.increment` trên `stars.<sid>` + `total` |
| Lưu cài đặt nhóm | `TTDB.syncGroup()` | 0 | 1 / nhóm | 1 `PATCH` + `updateMask`, không đụng `stars` của máy khác |
| Tạo nhóm | `TTDB.createGroup()` | 0 | 1 | gửi kèm `students` + `stars` + `total` trong cùng write |
| Đặt lại điểm | `TTDB.removeStar()` cho từng em | 0 | 1 / nhóm | vẫn là increment, gộp thành 1 commit |
| **Đổi tên lớp** | `TTDB.renameClassEverywhere()` | 1 | 1 + N | 1 write meta + N write `className`, gộp `:commit` (≤400/lần) |

### Đổi tên lớp — vì sao phải ghi HAI nơi

`className` được **denormalize** vào từng document nhóm để lọc theo lớp với **0 read**.
Nếu chỉ đổi tên trong `meta/hierarchy` thì danh mục hiện tên mới nhưng nhóm vẫn giữ tên cũ
→ hai nguồn sự thật lệch nhau, và lần sau `reconcileHierarchy` có thể dựng lại một lớp
trùng tên cũ. Vì vậy `renameClassEverywhere()` ghi cả hai trong cùng một luồng:

1. **1 write** — `meta/hierarchy` (PATCH + `updateMask=schools,updatedAt`, ~0,3 KB)
2. **N write** — mỗi nhóm một `update` chỉ gồm `className` + `updatedAt`
   (`updateMask`), payload ~60 B/nhóm. **Không** gửi `students`/`stars`/`total`
   → không thể ghi đè star mà máy khác vừa cộng.
3. N write được gộp vào **một** `:commit`, chia lô `MAX_WRITES_PER_COMMIT = 400`
   (Firestore cho 500, chừa biên an toàn). Nhiều lô → UI báo tiến trình
   “Đang lưu 400/900 nhóm…”.

**Với 6 nhóm: 1 read + 7 writes, ~0,7 KB egress.** Đây là thao tác **hiếm** (đầu năm học),
không nằm trên đường nóng như cộng star.

**An toàn:** nếu một lô lỗi, hierarchy đã đổi tên nhưng một số nhóm chưa. UI **hoàn tác**
tên cũ ngay và hiện lỗi tiếng Việt; gọi lại hàm này sẽ ghi tiếp phần còn lại
(idempotent — ghi cùng một `className` nhiều lần không sai).

**Chế độ Local:** chỉ ghi `localStorage`, và **chỉ gọi `localSave()` khi `db.js` thực sự
đang giữ danh sách nhóm** — nếu không sẽ ghi `[]` và xoá mất nhóm (lỗi thật đã gặp khi
kiểm thử, đã sửa).

### Adapter giữa hai model

UI dùng `members: [{id, name, stars}]`; Firestore dùng `students: [{id,name}]` + `stars: {sid: n}`.
Trang chuyển đổi qua lại bằng `fromDoc()` / `toPatch()`. **Star không bao giờ đi qua
`syncGroup`** — nếu đi, một lần lưu cài đặt sẽ ghi đè số star mà máy khác vừa cộng.

### Đồng bộ cache trước khi tăng/giảm

`changeStar()` trong `db.js` tự kẹp delta theo cache (`Math.max(0, cur + d)`). Vì vậy
trước khi gọi, trang đồng bộ cache về **giá trị trước lần bấm** (`newVal - delta`).
Nếu đồng bộ thẳng về `newVal`, lần trừ thứ hai sẽ bị kẹp về 0 và **mất thao tác**.
Đây là lỗi đã gặp và đã sửa khi kiểm thử (bấm ➖ hai lần chỉ ghi được một).

---

## 11. Ba việc tối ưu quota đã làm (phase 2025-10-31)

### ⚡ Việc 1 — Chống mất dữ liệu (không phải quota, nhưng ưu tiên cao nhất)

**Lỗi:** `syncGroup()`/`toPatch()` ghi cả `stars` và `total` trong `updateMask`.
Nghĩa là bấm "Lưu cài đặt" gửi **ảnh chụp điểm trên máy này** đè lên server:

```
cô A đang bấm star trên iPad  →  total = 12
tab khác bấm "Lưu cài đặt"    →  total = 7   ← mất 5 sao, không khôi phục được
```

**Đã sửa (2 lớp bảo vệ):**
1. `db.js → syncGroup()`: `stars`/`total` **bị loại khỏi `KEYS`** → không bao giờ
   vào `updateMask` của PATCH. Chỉ `createGroup()` ghi chúng (tạo mới, không có gì để đè).
2. `index.html → persistStruct()`: xoá `patch.stars` / `patch.total` khi `g._exists`.

**Kèm theo — xoá học sinh cho đúng sổ:** khi mảng `students` mới thiếu id nào thì
`syncGroup` thêm `stars.<sid>` vào `updateMask` (không có trong `fields` ⇒ Firestore
xoá hẳn key đó) và gửi `increment: -<star cũ>` cho `total`, **trong cùng một `:commit`**.
Trước đây `total` không được trừ khi xoá học sinh ⇒ sổ lệch dần.

**Keepalive:** `call()` thêm `keepalive: true` cho mọi method ≠ GET. Trước đây comment
gi là "dùng keepalive" nhưng code **không hề set** → trên `pagehide` trình duyệt huỷ
fetch đang bay ⇒ mất những star cuối (đang chờ gộp 1,2 s).

### ⚡ Việc 2 — Giảm reads từ vòng poll

| Hằng số | Cũ | Mới |
|---|---|---|
| `POLL_FAST_MS` | 4 000 | **15 000** |
| `POLL_SLOW_MS` | 15 000 | **30 000** |

Lý do: một truy vấn **rỗng vẫn tính 1 read**. Ở nhịp 4 s, một tiết 45 phút tốn
675 reads chỉ để hỏi "có gì mới không" — chiếm ~88 % tổng reads. Ở 15 s còn 180.

Vòng đời listener **không đổi** và đã được kiểm chứng lại:
- `document.hidden` ⇒ không poll, chỉ hẹn lại `POLL_SLOW_MS`.
- `pagehide` / `beforeunload` ⇒ `flushNow()` + `unsubscribe()` (nay có keepalive).
- Lỗi mạng ⇒ giãn ra `POLL_SLOW_MS`, không spam.

### ⚡ Việc 3 — Cache để cắt reads khi tải lại trang

**3a. `sessionStorage` cho danh sách nhóm — TTL 60 s**

| | Trước | Sau |
|---|---|---|
| F5 trong 60 s (30 nhóm) | 30 reads | **0 reads** |

- Key: `tt_cache_v1::{uid}::{featureId}` → hai tài khoản trên cùng máy không lẫn nhau.
- **`sessionStorage`, không `localStorage`**: sống theo tab, đóng tab là hết — không
  để lại dữ liệu học sinh trên máy dùng chung (phòng máy của trường).
- Cache được **cập nhật ngay ở mọi đường thay đổi**: `getGroups` (đọc mạng),
  `emit` (mọi thay đổi cục bộ), `pushLocal`, `removeLocal`, và cả `pollOnce`
  (dữ liệu từ máy khác về). Nhờ vậy F5 không bao giờ trả ảnh chụp cũ.
- Lỗi `sessionStorage` (chế độ riêng tư, đầy quota) được nuốt lặng: mất cache chỉ
  tốn thêm reads, **không bao giờ làm hỏng trang**.
- `signOut()` gọi `clearGroupsCache()` để dọn sạch.

**3b. `state.meta` cho khung trường/lớp — TTL 30 s**

Trước đây `getHierarchy()` **luôn** gọi mạng, và UI gọi thêm một lần nữa sau mỗi thao tác
⇒ mỗi lần tạo/đổi tên/xoá trường-lớp tốn **2 reads**. Nay còn **0–1**.
`saveHierarchy()` cũng làm mới mốc thời gian (mình vừa là nguồn sự thật).

**`reconcileHierarchy()` vẫn đúng:** nó đọc `state.groups[featureId]` (toàn bộ nhóm của
**mọi** lớp, không lọc) nên vẫn bù được danh mục bị mất. Đã có test riêng cho việc này.

### Kết quả tổng hợp — số giáo viên dùng được trên gói Spark

| Kịch bản | Reads/ngày/GV | GV tối đa (50 000 reads) |
|---|---|---|
| Trước tối ưu (poll 4 s, không cache) | ~3 840 | **13** |
| Sau tối ưu (poll 15 s, cache 60 s) | ~1 055 | **47** |

Cách tính: 5 tiết/ngày, mỗi tiết ≈ 211 reads (bảng mục 7).

### Cách đo lại

```bash
# dựng 30 nhóm rồi đo từng thao tác
node opt/test2.js        # emulator Firestore + Playwright, in bảng reads/writes thật
```

---

## 12. Tóm tắt một câu

> Mỗi **nhóm** là một document (~2,2 KB) chứa mảng `students` và map `stars`;
cộng star là **1 write bằng `increment`, 0 read**; mọi thay đổi trong 1,2 s được
gộp thành 1 commit; mở trang tốn **N+1 reads lần đầu, 0 read nếu F5 trong 60 s**;
`stars`/`total` **không bao giờ** bị ghi đè bởi thao tác cấu hình.
