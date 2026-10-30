# Firestore Schema — TeachTool

Tài liệu thiết kế cấu trúc dữ liệu Firestore cho TeachTool, tối ưu hạn ngạch
(quota) của gói **Spark (miễn phí)**.

- Đối tượng đọc: người phát triển TeachTool.
- Phạm vi: mô hình **user → feature → group → student (kèm số star)**.
- Mọi con số quota trong tài liệu này là **ước tính có tính toán**, ghi rõ giả định.
  Chúng chưa phải số đo thực tế trên Firebase Console.

---

## 1. Mô hình nghiệp vụ

```
Giáo viên (user)
  └── Tính năng (feature)  — ví dụ: star-race
        └── Nhóm (group)   — ví dụ: "Nhóm 1", "Tổ Sao Mai"
              └── Học sinh (student) + số star
```

Một giáo viên có nhiều tính năng. Trong mỗi tính năng có nhiều nhóm. Trong mỗi
nhóm có danh sách học sinh, mỗi em có một số star; nhóm cũng có tổng star.

Thao tác thực tế cần hỗ trợ (đây là danh sách dùng để chấm điểm các phương án):

| # | Thao tác | Tần suất thực tế |
|---|---|---|
| 1 | Mở trang chấm điểm | 1 lần / tiết |
| 2 | **Cộng 1 star cho 1 học sinh** | **rất cao** — hàng chục lần / tiết |
| 3 | Thêm học sinh | thấp — vài lần / tiết |
| 4 | Xoá học sinh | rất thấp |
| 5 | Thêm nhóm | rất thấp |
| 6 | Xoá nhóm | rất thấp |
| 7 | Đổi tên nhóm | rất thấp |
| 8 | Mở lại phiên (reload, đổi máy) | 1–2 lần / tiết |

> **Điểm mấu chốt:** thao tác #2 chiếm hơn 90% tổng lưu lượng. Mọi quyết định
> thiết kế phải tối ưu cho #2, kể cả khi phải hy sinh #1 một chút.

---

## 2. Ba phương án và đánh đổi

### Phương án A — Subcollection lồng sâu

```
users/{uid}/features/{featureId}/groups/{groupId}/students/{studentId}
   { name: "An", stars: 3 }
```

Mỗi học sinh là **một document riêng**.

- ✅ Ghi 1 star = 1 write vào document ~150 B. Rất nhỏ.
- ✅ Ghi đồng thời nhiều học sinh không tranh chấp (mỗi em một document).
- ❌ **Mở trang rất đắt:** phải đọc feature + N nhóm + N×M học sinh.
  Với 6 nhóm × 5 em = **37 reads** chỉ để hiện một màn hình.
- ❌ **Xoá nhóm = 6 writes** (1 nhóm + 5 học sinh). Không xoá được theo cascade
  phía client trong 1 write.
- ❌ Nhiều request: mỗi nhóm là một lần `list` riêng → 6 round-trip.
- ❌ Mỗi lần cuộn/đổi nhóm lại phát sinh thêm reads.

### Phương án B — Mỗi nhóm là 1 document, học sinh là mảng + map star

```
users/{uid}/features/{featureId}/groups/{groupId}
   { name: "Nhóm 1",
     students: [ {id:"s_a1", name:"An"}, {id:"s_b2", name:"Bình"} ],
     stars:    { s_a1: 3, s_b2: 5 },
     total: 8 }
```

- ✅ **Mở trang: 7 reads** (1 feature + 6 nhóm) thay vì 37.
- ✅ **Cộng 1 star = 1 write, không cần read trước** — nhờ `FieldTransform.increment`
  trên đúng một đường dẫn `stars.s_a1`. Không ghi lại cả document.
- ✅ **Xoá nhóm = 1 write** (chỉ 1 document).
- ✅ Ghi đồng thời 6 nhóm → 6 document khác nhau → **không chạm giới hạn 1 write/giây/document**.
- ✅ Mỗi document nhóm chỉ ~0,9 KB với 5 em; ~10 KB nếu 60 em → rất xa mức 1 MiB.
- ❌ Xoá học sinh cần 1 read trước (để biết số star của em đó) → 1 read + 1 write.
  Đây là thao tác hiếm, chấp nhận được.

### Phương án C — Một document cho mỗi (user, feature)

```
users/{uid}/features/{featureId}
   { groups: [ { id, name, students:[...], stars:{...} } ] }   ← TẤT CẢ trong 1 doc
```

- ✅ Mở trang: **1 read** — tốt nhất về reads.
- ❌ **Chạm trần 1 write/giây/document.** Cả lớp cùng bấm, hoặc giáo viên bấm liên
  tiếp qua nhiều nhóm, đều dồn vào **cùng một document** → bị throttle, mất star.
  Đây là rủi ro mất dữ liệu thật, không chỉ là chuyện quota.
- ❌ **Egress tệ nhất:** mỗi thay đổi, listener phải tải lại **toàn bộ** document
  (~8 KB). 60 lần bấm = ~500 KB egress, so với ~65 KB của phương án B.
- ❌ Ghi 1 star vẫn là 1 write, nhưng payload phải mang cả cấu trúc lớn → chậm hơn
  trên 3G/4G của trường học.

### Kết luận: chọn **Phương án B**

Lý do, bằng con số (1 tiết 40 phút, 6 nhóm × 5 học sinh, 60 lần bấm star):

| Chỉ số / tiết | A | **B (chọn)** | C |
|---|---|---|---|
| Reads | ~164 | **~72** | ~62 |
| Writes | ~71 | **~61** | ~60 |
| Egress | ~33 KB | **~65 KB** | ~500 KB |
| Reads khi mở trang | 37 | **7** | 1 |
| Writes khi xoá 1 nhóm | 6 | **1** | 1 |
| Rủi ro 1 write/giây/doc | Không | **Không** | **Có** |

B thắng vì: reads thấp gần bằng C, nhưng **không có trần 1 write/giây**, egress
nhỏ hơn C gần 8 lần, và mỗi thao tác phá huỷ (xoá nhóm) chỉ tốn 1 write thay vì 6.

---

## 3. Cây collection

```
/users/{uid}                                     ← 1 document / giáo viên
  ├─ username            string
  ├─ createdAt           timestamp
  ├─ lastSeenAt          timestamp
  ├─ plan                string        ("free")
  │
  └─ /features/{featureId}                       ← 1 document / tính năng
       ├─ title          string        ("Chấm điểm nhóm")
       ├─ createdAt      timestamp
       ├─ updatedAt      timestamp     ← watermark cho listener
       ├─ lastGroupId    string        ← mở lại đúng nhóm của lần trước
       │
       └─ /groups/{groupId}                      ← 1 document / nhóm  ★ ĐƠN VỊ GHI
            ├─ name      string
            ├─ order     number
            ├─ createdAt timestamp
            ├─ updatedAt timestamp   ← watermark, cập nhật mỗi lần ghi
            ├─ students  array<map{ id:string, name:string }>
            ├─ stars     map<studentId, number>   ← mỗi field tăng bằng increment
            └─ total     number                   ← tổng star của nhóm
```

`featureId` hiện dùng: `"star-race"`.
`groupId` dạng `g_xxxxxxxx`, `studentId` dạng `s_xxxxxxxx` (chỉ chữ thường + số +
dấu `_` — **không chứa dấu `.`**, vì id được dùng làm khoá trong `stars` và khoá
này trở thành một phần của field path khi gọi `increment`).

### Ý nghĩa từng field

| Đường dẫn | Kiểu | Ý nghĩa | Ghi chú quota |
|---|---|---|---|
| `users/{uid}/username` | string | Tên đăng nhập hiển thị | Không đổi sau khi tạo (rules chặn) |
| `users/{uid}/createdAt` | timestamp | Thời điểm tạo hồ sơ | Bất biến |
| `users/{uid}/lastSeenAt` | timestamp | Lần hoạt động cuối | Ghi tối đa 1 lần/ngày để tiết kiệm write |
| `users/{uid}/plan` | string | Gói sử dụng | **Client không được ghi** (rules chặn) |
| `features/{fid}/title` | string | Tên hiển thị của tính năng | |
| `features/{fid}/updatedAt` | timestamp | Mốc thay đổi gần nhất | Cho listener cấp feature |
| `features/{fid}/lastGroupId` | string | Nhóm mở gần nhất | 1 write khi đổi nhóm (gộp được) |
| `groups/{gid}/name` | string | Tên nhóm, 1–60 ký tự | |
| `groups/{gid}/order` | number | Thứ tự hiển thị | |
| `groups/{gid}/students` | array\<map\> | Danh sách học sinh | Thêm/xoá bằng `arrayUnion` / `arrayRemove` |
| `groups/{gid}/stars` | map\<string,int\> | Star của từng em | **Tăng bằng `increment`, không ghi lại map** |
| `groups/{gid}/total` | number | Tổng star của nhóm | Tăng **cùng lúc** trong cùng 1 write |
| `groups/{gid}/updatedAt` | timestamp | Mốc thay đổi | Dùng cho watermark của listener |

### Vì sao tách `stars` khỏi `students`?

Nếu để `students: [{id, name, stars}]` thì mỗi lần cộng star phải **đọc document,
sửa mảng, ghi lại toàn bộ** (1 read + 1 write + payload lớn). Với `stars` là map
riêng, ta dùng `FieldTransform.increment` trên `stars.<id>` → **1 write, 0 read,
payload ~230 B**, và hai giáo viên / hai tab bấm cùng lúc không ghi đè nhau.

`total` được tăng song song trong **cùng một transform write**, nên vẫn chỉ tính là
1 document write.

---

## 4. Ví dụ document mẫu

### `users/{uid}`

```json
{
  "name": "projects/teachtool/databases/(default)/documents/users/Xk29fLmQ...",
  "fields": {
    "username":   { "stringValue": "coNga" },
    "createdAt":  { "timestampValue": "2026-10-30T02:10:00Z" },
    "lastSeenAt": { "timestampValue": "2026-10-31T01:20:00Z" },
    "plan":       { "stringValue": "free" }
  }
}
```

### `users/{uid}/features/star-race/groups/g_7f3a91c2`

```json
{
  "name": "projects/teachtool/databases/(default)/documents/users/Xk29fLmQ.../features/star-race/groups/g_7f3a91c2",
  "fields": {
    "name":    { "stringValue": "Nhóm 1" },
    "order":   { "integerValue": "1" },
    "createdAt": { "timestampValue": "2026-10-30T02:12:00Z" },
    "updatedAt": { "timestampValue": "2026-10-31T01:18:42Z" },
    "students": {
      "arrayValue": {
        "values": [
          { "mapValue": { "fields": { "id": { "stringValue": "s_a1b2c3" }, "name": { "stringValue": "An" } } } },
          { "mapValue": { "fields": { "id": { "stringValue": "s_d4e5f6" }, "name": { "stringValue": "Bình" } } } },
          { "mapValue": { "fields": { "id": { "stringValue": "s_g7h8i9" }, "name": { "stringValue": "Chi" } } } },
          { "mapValue": { "fields": { "id": { "stringValue": "s_j0k1l2" }, "name": { "stringValue": "Dũng" } } } },
          { "mapValue": { "fields": { "id": { "stringValue": "s_m3n4o5" }, "name": { "stringValue": "Em" } } } }
        ]
      }
    },
    "stars": {
      "mapValue": {
        "fields": {
          "s_a1b2c3": { "integerValue": "3" },
          "s_d4e5f6": { "integerValue": "5" },
          "s_g7h8i9": { "integerValue": "2" },
          "s_j0k1l2": { "integerValue": "4" },
          "s_m3n4o5": { "integerValue": "1" }
        }
      }
    },
    "total": { "integerValue": "15" }
  }
}
```

### Ví dụ dạng "thân thiện" (đọc bằng SDK sẽ thấy như sau)

```json
{
  "name": "Nhóm 1",
  "order": 1,
  "students": [
    { "id": "s_a1b2c3", "name": "An" },
    { "id": "s_d4e5f6", "name": "Bình" },
    { "id": "s_g7h8i9", "name": "Chi" },
    { "id": "s_j0k1l2", "name": "Dũng" },
    { "id": "s_m3n4o5", "name": "Em" }
  ],
  "stars": { "s_a1b2c3": 3, "s_d4e5f6": 5, "s_g7h8i9": 2, "s_j0k1l2": 4, "s_m3n4o5": 1 },
  "total": 15
}
```

---

## 5. Chi phí từng thao tác (phương án B)

Đơn vị: 1 "read"/"write" = 1 document read/write theo cách Firebase tính tiền.

| Thao tác | Reads | Writes | Payload ghi | Ghi chú |
|---|---|---|---|---|
| Mở trang chấm điểm | **7** | 0 | — | 1 feature + 6 nhóm |
| Mở lại phiên (reload) | **7** | 0 | — | |
| **Cộng 1 star** | **0** | **1** | ~230 B | `increment` trên `stars.<id>` + `total` |
| Cộng 5 star cùng nhóm trong 1,2 s | 0 | **1** | ~600 B | gộp bằng coalescing (`js/db.js`) |
| Trừ 1 star | 0 | 1 | ~230 B | `increment` với giá trị âm |
| Thêm học sinh | 0 | 1 | ~700 B | `arrayUnion` + `order`, không cần đọc trước |
| Xoá học sinh | **1** | 1 | ~900 B | cần biết star hiện tại của em đó |
| Thêm nhóm | 0 | 1 | ~400 B | |
| **Xoá nhóm** | 0 | **1** | — | chỉ 1 document (A cần 6) |
| Đổi tên nhóm | 0 | 1 | ~300 B | |
| Poll listener (rảnh) | 1 | 0 | — | 1 lần/phút khi không có thay đổi |

Bảng trên giả định listener dùng **truy vấn có watermark** (`updatedAt > mốc`):
mỗi lần poll chỉ tính 1 read tối thiểu, cộng 1 read cho mỗi document thực sự đổi.

---

## 6. Ước tính quota cho **1 tiết học 40 phút**

**Giả định:** 6 nhóm × 5 học sinh = 30 em; giáo viên bấm **60 lần** cộng star
(trung bình mỗi em 2 star); thêm 2 học sinh, xoá 1, thêm 1 nhóm, xoá 1 nhóm, đổi
tên 1 nhóm, mở lại trang 1 lần.

### 6.1 Tổng theo tiết

| Hạng mục | Reads | Writes | Egress |
|---|---|---|---|
| Mở trang (lần 1) | 7 | 0 | ~6 KB |
| 60 lần cộng star | 60 (listener) | 60 | ~55 KB |
| Thêm 2 học sinh | 2 | 2 | ~1,5 KB |
| Xoá 1 học sinh | 1 | 1 | ~1 KB |
| Thêm 1 nhóm | 0 | 1 | ~0,4 KB |
| Xoá 1 nhóm | 0 | 1 | ~0,4 KB |
| Đổi tên 1 nhóm | 0 | 1 | ~0,3 KB |
| Mở lại trang | 7 | 0 | ~6 KB |
| **TỔNG** | **≈ 77** | **≈ 66** | **≈ 71 KB** |

Nếu gộp star tốt (coalescing 1,2 s), số write thực tế thường rơi vào **50–60**.

### 6.2 So với hạn ngạch Spark

Spark (miễn phí, **tính trên toàn project**, không phải trên từng user):

| Hạn ngạch Spark | Giới hạn | 1 tiết dùng | Số tiết tối đa / ngày | Kết luận |
|---|---|---|---|---|
| Document reads | 50.000 / ngày | ≈ 77 | **≈ 649 tiết** | Thoải mái |
| Document writes | 20.000 / ngày | ≈ 66 | **≈ 303 tiết** | **Nút thắt** |
| Lưu trữ | 1 GiB | ≈ 12 KB / giáo viên | **≈ 85.000 giáo viên** | Không đáng lo |
| Egress | 10 GiB / tháng | ≈ 71 KB | ≈ 147.000 tiết | Không đáng lo |

**Kết luận:** với phương án B, **ghi (writes) là hạn ngạch chặn trước**, ở mức
khoảng **300 tiết học/ngày cho toàn bộ project**. Một giáo viên dạy 5 tiết/ngày chỉ
dùng ~330 write = **1,6 %** hạn ngạch ngày. Với quy mô một trường (30 giáo viên,
5 tiết/ngày) là ~10.000 write/ngày = 50 % — vẫn trong Spark, nhưng nên theo dõi.

> Nếu vượt: bật **coalescing dài hơn** (2 s thay vì 1,2 s) giảm ~20 % write; hoặc
> chuyển sang gói Blaze (trả theo dùng, vài chục nghìn VND/tháng cho quy mô trường).

### 6.3 Nếu dùng polling thay cho listener

`js/db.js` mặc định poll có watermark (4 s khi đang hoạt động → 15 s khi rảnh).
Trong 40 phút, ước tính ~450–500 lần poll:

| Reads / tiết | Số tiết tối đa / ngày (50k reads) |
|---|---|
| ≈ 500 | ≈ 100 tiết |

Vẫn dùng được cho một giáo viên, nhưng **kém hiệu quả hơn listener thật ~6,5 lần**.
Khi có điều kiện dùng SDK (đăng nhập bằng SDK Firebase Auth), nên chuyển sang
`onSnapshot` — xem mục 9.

---

## 7. Ràng buộc kỹ thuật đã tính đến

### 7.1 Giới hạn 1 MiB / document

| Thành phần | Kích thước ước tính |
|---|---|
| 1 học sinh trong `students` (id 8 + name 20 ký tự tiếng Việt) | ~45 B |
| 1 field trong `stars` (`s_xxxxxx`: 6 → 40) | ~22 B |
| Overhead tên field + kiểu | ~120 B |
| **Document nhóm, 5 em** | **~0,9 KB** |
| **Document nhóm, 60 em** | **~9,5 KB** |
| **Document nhóm, 200 em (trần rules)** | **~31 KB** |

Còn cách 1 MiB **hơn 30 lần** ngay ở mức trần 200 em/nhóm. An toàn.

Ngoài ra Firestore giới hạn **20.000 index entry / document**; với `students` và
`stars` đã được **tắt đánh chỉ mục** trong `firestore.indexes.json` nên giới hạn
này gần như không thể chạm.

### 7.2 Giới hạn 1 write/giây/document

- Mỗi nhóm là **một document riêng** → bấm ở Nhóm 1 và Nhóm 2 không tranh chấp.
- Trong cùng một nhóm, `js/db.js` **gộp mọi thay đổi trong 1,2 s thành 1 commit** →
  một giáo viên bấm liên tục 10 lần/giây cũng chỉ tạo ~0,8 write/giây/nhóm.
- Hai thiết bị cùng sửa một nhóm: `increment` là **phép cộng nguyên tử phía server**,
  không ghi đè lẫn nhau — đây là lý do không dùng "đọc rồi ghi".
- Nếu vẫn vượt (nhiều giáo viên cùng vào một tài khoản), Firestore trả lỗi
  `ABORTED`; `js/db.js` tự thử lại với backoff.

### 7.3 Vì sao không ghi cả document mỗi lần bấm star

Mỗi lần bấm star gửi **một `FieldTransform`**, không gửi document:

```json
{
  "writes": [{
    "transform": {
      "document": "projects/P/databases/(default)/documents/users/UID/features/star-race/groups/g_7f3a91c2",
      "fieldTransforms": [
        { "fieldPath": "stars.s_a1b2c3", "increment": { "integerValue": "1" } },
        { "fieldPath": "total",         "increment": { "integerValue": "1" } }
      ]
    }
  }]
}
```

Payload ~230 B, **0 read**, và không có nguy cơ "đọc-cũ-rồi-ghi-đè" làm mất star
của thiết bị khác.

---

## 8. Bảo mật

Xem `firestore.rules`. Nguyên tắc:

1. Mọi đường dẫn nằm dưới `/users/{uid}` chỉ cho phép khi `request.auth.uid == uid`.
2. Không có bất kỳ `allow read, write: if true` nào.
3. Mặc định từ chối (`match /{document=**}` → `allow read, write: if false`).
4. Validate kiểu và độ dài để chặn document phình to hoặc dữ liệu rác.
5. `username`, `createdAt`, `plan` **bất biến** sau khi tạo.

Bảo mật dữ liệu đến từ **rules**, không phải từ việc giấu `apiKey` — `apiKey` của
Firebase Web SDK là thông tin công khai theo thiết kế.

---

## 9. Triển khai listener (đọc kỹ trước khi đổi)

`js/db.js` dùng **Firestore REST** nên chỉ có token, không có SDK Auth. Lý do:
`index.html` đăng nhập bằng Firebase Auth REST và chỉ lưu `idToken`, nên **không
thể** dùng `onSnapshot` của SDK (SDK cần phiên đăng nhập của chính nó).

Vì vậy listener được cài bằng **truy vấn có watermark**, chạy trong **đúng một**
timer toàn trang:

- `POST :runQuery` với `where updatedAt > mốc` + `orderBy updatedAt`.
- Chỉ tài liệu **thật sự đổi** mới được trả về → 1 read/document đổi.
- Poll nhanh 4 s khi có thay đổi, tự giãn 15 s sau 2 phút rảnh.
- **Tạm dừng** khi `document.hidden`, chạy lại khi tab hiện.
- Tự `unsubscribe` khi rời trang (`pagehide`) → **không bao giờ có 2 listener**.

Muốn chuyển sang `onSnapshot` thật: đăng nhập bằng SDK Firebase Auth, thay
`subscribeGroups()` bằng `onSnapshot(query(collection(db,'users',uid,'features',fid,'groups')))`
và giữ nguyên phần ghi REST (`increment`) — phần ghi này đã tối ưu rồi.

---

## 10. Tóm tắt một câu

> Mỗi **nhóm** là một document (~0,9 KB) chứa mảng `students` và map `stars`;
> cộng star là **1 write bằng `increment`, 0 read**; mọi thay đổi trong 1,2 s được
> gộp thành 1 commit; mở trang chỉ tốn **7 reads**. Đây là điểm cân bằng tốt nhất
> giữa reads, writes và egress trên gói Spark.
