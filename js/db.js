/* ============================================================================
 * TeachTool — js/db.js
 * Lớp truy cập Firestore dùng chung cho mọi tính năng.
 * ----------------------------------------------------------------------------
 * CẤU TRÚC ĐÃ CHỌN (phương án B — xem docs/firestore-schema.md):
 *
 *   users/{uid}/features/{featureId}/groups/{groupId}
 *       { name, order, students:[{id,name}], stars:{studentId:n}, total, ... }
 *
 * TẠI SAO KHÔNG DÙNG SDK?
 *   index.html đăng nhập bằng Firebase Auth REST và chỉ lưu `idToken` trong
 *   localStorage (không có SDK Auth). onSnapshot của SDK đòi hỏi phiên đăng nhập
 *   của chính SDK, nên ở đây dùng thẳng REST API v1. Đổi lại:
 *     • Không tải ~120 KB JS từ CDN (tốt cho mạng trường học).
 *     • Kiểm soát tuyệt đối số request → tối ưu quota.
 *     • Phần GHI vẫn dùng FieldTransform.increment y như SDK.
 *
 * BA TỐI ƯU QUOTA CỐT LÕI:
 *   1. Cộng star = 1 write, 0 read  → dùng `increment` trên đúng 1 field,
 *      KHÔNG bao giờ ghi lại cả document.
 *   2. Gộp thao tác (coalescing)     → mọi thay đổi trong 1,2 giây thành 1 commit.
 *   3. Đúng MỘT listener             → poll có watermark, tự giãn nhịp, tự huỷ.
 *
 * KHÔNG hardcode key: projectId + apiKey đọc từ /api/config.js (ENV trên Vercel),
 * token đọc từ phiên đăng nhập do index.html lưu.
 * ========================================================================== */

(function (global) {
  "use strict";

  /* ==========================================================================
   * 0. HẰNG SỐ
   * ======================================================================== */

  var SESSION_KEY = "tt_session_v1";
  var LS_GROUPS   = "tt_groups_v1";     // chỉ dùng ở chế độ local

  // Gộp thao tác: mọi thay đổi trong khoảng này thành 1 commit duy nhất.
  // 1200 ms là điểm cân bằng: người dùng vẫn thấy phản hồi tức thì (UI cập nhật
  // lạc quan), nhưng 10 lần bấm liên tiếp chỉ tốn 1 write thay vì 10.
  var COALESCE_MS = 1200;

  // Nhịp poll listener. Nhanh khi vừa có thay đổi, giãn ra khi rảnh.
  var POLL_FAST_MS  = 4000;
  var POLL_SLOW_MS  = 15000;
  var POLL_IDLE_AFTER_MS = 120000;      // sau 2 phút không đổi → chuyển nhịp chậm

  var MAX_WRITES_PER_COMMIT = 400;      // Firestore cho 500; chừa biên an toàn
  var MAX_STUDENTS = 200;               // khớp firestore.rules

  var API_BASE = "https://firestore.googleapis.com/v1";

  /* ==========================================================================
   * 1. TRẠNG THÁI NỘI BỘ
   * ======================================================================== */

  var state = {
    ready:     false,
    backend:   "local",       // "firestore" | "local"
    projectId: null,
    apiKey:    null,
    uid:       null,
    token:     null,
    userName:  null,

    // cache nhóm theo featureId -> array<group>
    groups:    Object.create(null),

    // hàng đợi ghi đang chờ gộp: featureId -> groupId -> { stars:{sid:delta}, total:delta }
    pending:   Object.create(null),

    flushTimer: null,
    flushing:   false,

    // listener
    listener:   null,         // { featureId, timer, onData, watermark, lastChangeAt, stopped, inFlight }
    subscribers: [],          // callback người dùng đăng ký

    // callback báo lỗi cho UI
    onError: null,
    onStatus: null
  };

  /* ==========================================================================
   * 2. TIỆN ÍCH CHUNG
   * ======================================================================== */

  function nowIso() { return new Date().toISOString(); }

  function randId(prefix) {
    // Chỉ chữ thường + số + "_" để dùng được làm khoá map `stars`
    // và làm một phần field path của `increment` (rules cũng chặn ký tự khác).
    var s = "";
    var abc = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (var i = 0; i < 10; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
    return (prefix || "") + s;
  }

  function warn(msg) {
    if (typeof console !== "undefined" && console.warn) console.warn("[TTDB] " + msg);
  }

  function fail(err) {
    if (typeof state.onError === "function") {
      try { state.onError(err); } catch (e) { /* UI lỗi thì bỏ qua */ }
    }
    return err;
  }

  function status(s) {
    if (typeof state.onStatus === "function") {
      try { state.onStatus(s); } catch (e) { /* bỏ qua */ }
    }
  }

  /* ==========================================================================
   * 3. MÃ HOÁ / GIẢI MÃ GIÁ TRỊ FIRESTORE REST
   * --------------------------------------------------------------------------
   * Firestore REST bọc mọi giá trị trong một object có kiểu tường minh.
   * Hai hàm dưới chuyển đổi qua lại với JS thuần.
   * ======================================================================== */

  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "string")        return { stringValue: v };
    if (typeof v === "boolean")       return { booleanValue: v };
    if (typeof v === "number") {
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (Array.isArray(v)) {
      return { arrayValue: { values: v.map(enc) } };
    }
    if (typeof v === "object") {
      var f = {};
      Object.keys(v).forEach(function (k) { f[k] = enc(v[k]); });
      return { mapValue: { fields: f } };
    }
    return { nullValue: null };
  }

  function dec(v) {
    if (!v || typeof v !== "object") return null;
    if ("nullValue"    in v) return null;
    if ("stringValue"  in v) return v.stringValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("integerValue" in v) return parseInt(v.integerValue, 10);
    if ("doubleValue"  in v) return Number(v.doubleValue);
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue"   in v) return (v.arrayValue.values || []).map(dec);
    if ("mapValue"     in v) {
      var out = {};
      var f = v.mapValue.fields || {};
      Object.keys(f).forEach(function (k) { out[k] = dec(f[k]); });
      return out;
    }
    return null;
  }

  function decFields(doc) {
    var out = {};
    var f = (doc && doc.fields) || {};
    Object.keys(f).forEach(function (k) { out[k] = dec(f[k]); });
    // id lấy từ đoạn cuối của tên document
    if (doc && doc.name) out.id = doc.name.split("/").pop();
    return out;
  }

  /* ==========================================================================
   * 4. KHỞI TẠO — đọc phiên + cấu hình
   * ======================================================================== */

  function readSession() {
    try {
      var raw = global.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.u) return null;
      if (s.ex && Date.now() > s.ex) return null;   // hết hạn
      return s;
    } catch (e) { return null; }
  }

  // Lấy uid thật của Firebase từ JWT idToken (payload base64url).
  // Không cần SDK, không cần verify chữ ký — phía server (Firestore) tự verify.
  function uidFromToken(token) {
    try {
      var parts = String(token).split(".");
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var payload = JSON.parse(atob(b64));
      return payload.user_id || payload.sub || null;
    } catch (e) { return null; }
  }

  function loadConfig() {
    if (global.TEACHTOOL_CONFIG) return Promise.resolve(global.TEACHTOOL_CONFIG);
    var paths = ["/api/config.js", "api/config.js"];
    function tryAt(i) {
      if (i >= paths.length) return Promise.resolve(null);
      return fetch(paths[i], { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cfg) {
          if (cfg) { global.TEACHTOOL_CONFIG = cfg; return cfg; }
          return tryAt(i + 1);
        })
        .catch(function () { return tryAt(i + 1); });
    }
    if (typeof fetch !== "function" || global.location.protocol === "file:") {
      return Promise.resolve(null);
    }
    return tryAt(0);
  }

  /**
   * init() — gọi một lần khi trang tải.
   * Tự chọn backend: có Firebase config → "firestore", không → "local".
   * Trang vẫn chạy được ngay cả khi chưa cấu hình Firebase.
   */
  function init() {
    var sess = readSession();
    state.userName = sess ? sess.u : null;
    state.token = sess ? (sess.t || "") : "";

    return loadConfig().then(function (cfg) {
      var fb = cfg && cfg.firebase;

      if (fb && fb.projectId && fb.apiKey && state.token) {
        state.backend   = "firestore";
        state.projectId = fb.projectId;
        state.apiKey    = fb.apiKey;                 // công khai theo thiết kế Firebase
        state.uid       = uidFromToken(state.token) || ("u_" + state.userName);
      } else {
        state.backend = "local";
        state.uid     = "local_" + (state.userName || "guest");
        if (fb && fb.projectId && !state.token) {
          warn("Có cấu hình Firebase nhưng phiên không có idToken — tạm dùng chế độ local.");
        }
      }

      state.ready = true;
      status({ backend: state.backend, uid: state.uid, user: state.userName });
      return state;
    });
  }

  /* ==========================================================================
   * 5. ĐƯỜNG DẪN & GỌI REST
   * ======================================================================== */

  function docRoot() {
    return API_BASE + "/projects/" + state.projectId +
           "/databases/(default)/documents";
  }

  function userPath() { return "users/" + state.uid; }

  function featurePath(featureId) {
    return userPath() + "/features/" + featureId;
  }

  function groupPath(featureId, groupId) {
    return featurePath(featureId) + "/groups/" + groupId;
  }

  function fullName(relPath) {
    return "projects/" + state.projectId +
           "/databases/(default)/documents/" + relPath;
  }

  // Gom 1 lần gọi REST. Tự thêm Authorization: Bearer <idToken>.
  // Không có key bí mật nào ở đây — chỉ idToken của chính người dùng.
  function call(method, url, body, retry) {
    var attempt = retry || 0;
    var opt = {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + state.token
      },
      cache: "no-store"
    };
    if (body !== undefined) opt.body = JSON.stringify(body);

    return fetch(url, opt).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }

        if (r.ok) return data;

        var code = (data && data.error && data.error.status) || ("HTTP_" + r.status);

        // 1 write/giây/document bị vượt → ABORTED. Thử lại với backoff.
        // Đây chính là cơ chế bảo vệ cho giới hạn 1 write/s/doc.
        if ((code === "ABORTED" || code === "RESOURCE_EXHAUSTED" ||
             code === "UNAVAILABLE" || r.status === 429 || r.status === 503) && attempt < 4) {
          var wait = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
          return new Promise(function (res) { setTimeout(res, wait); })
            .then(function () { return call(method, url, body, attempt + 1); });
        }

        var err = new Error(code);
        err.status = r.status;
        err.detail = data && data.error;
        throw err;
      });
    });
  }

  /* ==========================================================================
   * 6. ĐỌC DANH SÁCH NHÓM
   * ======================================================================== */

  /**
   * getGroups(featureId) → Promise<array<group>>
   *
   * QUOTA: N reads (N = số nhóm). Với 6 nhóm = 6 reads. Đây là chi phí mở trang.
   * KHÔNG đọc từng học sinh — học sinh nằm ngay trong document nhóm (phương án B),
   * nhờ vậy mở trang chỉ tốn 6 reads thay vì 37 reads như phương án A.
   */
  function getGroups(featureId) {
    if (state.backend === "local") return Promise.resolve(localGetGroups(featureId));

    var url = docRoot() + "/" + featurePath(featureId) + ":runQuery";
    var q = {
      structuredQuery: {
        from: [{ collectionId: "groups" }],
        orderBy: [{ field: { fieldPath: "order" }, direction: "ASCENDING" }]
      }
    };

    return call("POST", url, q).then(function (rows) {
      var list = [];
      (rows || []).forEach(function (row) {
        if (row && row.document) list.push(decFields(row.document));
      });
      state.groups[featureId] = list;
      return list;
    }).catch(function (e) {
      // Không đọc được (mạng / quyền) → trả cache cũ nếu có, đừng làm sập UI
      warn("getGroups lỗi: " + e.message);
      if (state.groups[featureId]) return state.groups[featureId];
      return fail(e);
    });
  }

  /* ==========================================================================
   * 7. TẠO / XOÁ / ĐỔI TÊN NHÓM
   * ======================================================================== */

  /**
   * createGroup(featureId, name, order) → Promise<group>
   * QUOTA: 0 read + 1 write.
   */
  function createGroup(featureId, name, order) {
    var gid = randId("g_");
    var now = nowIso();
    var doc = {
      name: (name || "Nhóm mới").slice(0, 60),
      order: typeof order === "number" ? order : ((state.groups[featureId] || []).length + 1),
      createdAt: now,
      updatedAt: now,
      students: [],
      stars: {},
      total: 0
    };

    if (state.backend === "local") {
      var g = localCreateGroup(featureId, gid, doc);
      emit(featureId);
      return Promise.resolve(g);
    }

    var url = docRoot() + "/" + featurePath(featureId) + "/groups?documentId=" + gid;
    var fields = {};
    Object.keys(doc).forEach(function (k) {
      if (k === "createdAt" || k === "updatedAt") fields[k] = { timestampValue: doc[k] };
      else fields[k] = enc(doc[k]);
    });

    return call("POST", url, { fields: fields }).then(function (res) {
      // Xây group từ dữ liệu CỤC BỘ (đã biết chắc id + doc), dùng response chỉ
      // để bổ sung field server sinh ra (vd: createTime). Nhờ vậy không phụ
      // thuộc vào hình dạng response của REST API.
      var merged = Object.assign({ id: gid }, doc);
      if (res && res.fields) {
        var fromServer = decFields(res);
        Object.keys(fromServer).forEach(function (k) {
          if (fromServer[k] !== undefined && fromServer[k] !== null) merged[k] = fromServer[k];
        });
        merged.id = gid;
      }
      pushLocal(featureId, merged);
      emit(featureId);
      return merged;
    });
  }

  /**
   * deleteGroup(featureId, groupId) → Promise<void>
   *
   * QUOTA: 0 read + 1 write.
   * ĐÂY LÀ LỢI THẾ LỚN CỦA PHƯƠNG ÁN B: học sinh nằm trong chính document nhóm,
   * nên xoá nhóm = xoá 1 document. Phương án A (subcollection) phải xoá 1 + N
   * document (6 writes cho nhóm 5 em), và mỗi document là 1 write tính tiền.
   */
  function deleteGroup(featureId, groupId) {
    if (state.backend === "local") {
      localDeleteGroup(featureId, groupId);
      emit(featureId);
      return Promise.resolve();
    }
    // Xoá mọi thay đổi đang chờ của nhóm này — không ghi vào document sắp mất.
    clearPending(featureId, groupId);

    var url = docRoot() + "/" + groupPath(featureId, groupId);
    return call("DELETE", url).then(function () {
      removeLocal(featureId, groupId);
      emit(featureId);
    });
  }

  /**
   * renameGroup(featureId, groupId, name) → Promise<void>
   * QUOTA: 0 read + 1 write (PATCH có updateMask → chỉ gửi field đổi).
   */
  function renameGroup(featureId, groupId, name) {
    var newName = String(name || "").trim().slice(0, 60);
    if (!newName) return Promise.reject(fail(new Error("EMPTY_NAME")));

    if (state.backend === "local") {
      var g = localFind(featureId, groupId);
      if (g) { g.name = newName; g.updatedAt = nowIso(); localSave(featureId); }
      emit(featureId);
      return Promise.resolve();
    }

    var path = groupPath(featureId, groupId);
    var url = docRoot() + "/" + path +
              "?updateMask.fieldPaths=name&updateMask.fieldPaths=updatedAt";
    var body = {
      fields: { name: { stringValue: newName }, updatedAt: { timestampValue: nowIso() } }
    };

    return call("PATCH", url, body).then(function () {
      var lg = localFind(featureId, groupId);
      if (lg) { lg.name = newName; lg.updatedAt = nowIso(); }
      emit(featureId);
    });
  }

  /* ==========================================================================
   * 8. HỌC SINH
   * ======================================================================== */

  /**
   * addStudent(featureId, groupId, name) → Promise<student>
   *
   * QUOTA: 0 read + 1 write.
   * Dùng FieldTransform `appendMissingElements` để nối vào mảng `students`
   * NGAY TRÊN SERVER — không cần đọc document trước, không ghi đè mảng của
   * thiết bị khác (hai cô cùng thêm học sinh vẫn đúng).
   */
  function addStudent(featureId, groupId, name) {
    var sname = String(name || "").trim().slice(0, 40);
    if (!sname) return Promise.reject(fail(new Error("EMPTY_NAME")));

    var g = localFind(featureId, groupId);
    if (g && (g.students || []).length >= MAX_STUDENTS) {
      return Promise.reject(fail(new Error("TOO_MANY_STUDENTS")));
    }

    var sid = randId("s_");
    var student = { id: sid, name: sname };

    if (state.backend === "local") {
      if (g) {
        g.students = (g.students || []).concat([student]);
        g.stars = g.stars || {};
        g.stars[sid] = 0;
        g.updatedAt = nowIso();
        localSave(featureId);
      }
      emit(featureId);
      return Promise.resolve(student);
    }

    var commitUrl = docRoot() + ":commit";
    var body = {
      writes: [{
        transform: {
          document: fullName(groupPath(featureId, groupId)),
          fieldTransforms: [
            {
              fieldPath: "students",
              appendMissingElements: { values: [enc(student)] }
            },
            { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
          ]
        }
      }]
    };

    return call("POST", commitUrl, body).then(function () {
      if (g) {
        g.students = (g.students || []).concat([student]);
        g.stars = g.stars || {};
        g.stars[sid] = g.stars[sid] || 0;
        g.updatedAt = nowIso();
      }
      emit(featureId);
      return student;
    });
  }

  /**
   * removeStudent(featureId, groupId, studentId, knownStars) → Promise<void>
   *
   * QUOTA:
   *   • knownStars là số → 0 read + 1 write  (UI đã biết star của em đó)
   *   • không truyền      → 1 read  + 1 write (phải đọc để biết trừ `total` bao nhiêu)
   *
   * Vì sao đọc? `total` là tổng star; xoá học sinh phải trừ đúng số star của em
   * đó khỏi tổng. Nếu không biết trước, buộc phải đọc. Thao tác này hiếm nên
   * 1 read là chấp nhận được (xem bảng quota trong docs/firestore-schema.md).
   */
  function removeStudent(featureId, groupId, studentId, knownStars) {
    var g = localFind(featureId, groupId);

    function applyWith(stars) {
      var delta = -(Number(stars) || 0);

      if (state.backend === "local") {
        if (g) {
          var target = (g.students || []).filter(function (s) { return s.id === studentId; })[0];
          g.students = (g.students || []).filter(function (s) { return s.id !== studentId; });
          if (g.stars) delete g.stars[studentId];
          g.total = Math.max(0, (g.total || 0) + delta);
          g.updatedAt = nowIso();
          localSave(featureId);
          void target;
        }
        emit(featureId);
        return Promise.resolve();
      }

      // ★ MỘT write duy nhất cho toàn bộ thao tác.
      //
      // Cách làm: dùng PATCH với updateMask gồm đúng 3 đường dẫn
      //   students        → ghi mảng mới (đã bỏ em đó)
      //   total           → ghi tổng mới (đã trừ star của em đó)
      //   stars.<sid>     → KHÔNG có trong `fields` ⇒ Firestore XOÁ field này
      //
      // Vì sao không dùng 3 write? Ba write trên CÙNG một document sẽ vi phạm
      // giới hạn 1 write/giây/document và bị tính 3 lần vào quota. Một PATCH
      // gộp lại là 1 write, atomic, và không bao giờ vượt ngưỡng.
      var path = groupPath(featureId, groupId);
      var newTotal = Math.max(0, (g ? Number(g.total || 0) : 0) + delta);
      var newStudents = g
        ? (g.students || []).filter(function (s) { return s.id !== studentId; })
        : null;

      var fields = { total: { integerValue: String(newTotal) } };
      var masks  = ["total", "stars." + studentId];

      if (newStudents) {
        fields.students = enc(newStudents);
        masks.push("students");
      }

      var url = docRoot() + "/" + path +
                masks.map(function (m) { return "&updateMask.fieldPaths=" + encodeURIComponent(m); })
                     .join("").replace(/^&/, "?");

      return call("PATCH", url, { fields: fields }).then(function () {
        if (g) {
          if (newStudents) g.students = newStudents;
          if (g.stars) delete g.stars[studentId];
          g.total = newTotal;
          g.updatedAt = nowIso();
        }
        emit(featureId);
      });
    }

    if (typeof knownStars === "number") return applyWith(knownStars);

    // Chưa biết star → đọc document (1 read) rồi mới ghi.
    if (state.backend === "local") {
      var st = g && g.stars ? g.stars[studentId] : 0;
      return applyWith(st);
    }
    return getGroup(featureId, groupId).then(function (doc) {
      return applyWith(doc && doc.stars ? (doc.stars[studentId] || 0) : 0);
    });
  }

  /** getGroup(featureId, groupId) → Promise<document> — 1 read. */
  function getGroup(featureId, groupId) {
    if (state.backend === "local") return Promise.resolve(localFind(featureId, groupId));
    var url = docRoot() + "/" + groupPath(featureId, groupId);
    return call("GET", url).then(decFields);
  }

  /* ==========================================================================
   * 9. CỘNG / TRỪ STAR — PHẦN TỐI ƯU QUAN TRỌNG NHẤT
   * ======================================================================== */

  /**
   * addStar(featureId, groupId, studentId, n) — mặc định +1.
   *
   * QUOTA: 0 read + (gộp) 1 write / 1,2 giây / nhóm.
   *
   * CƠ CHẾ:
   *   1. UI được cập nhật NGAY (lạc quan) → cảm giác tức thì, không chờ mạng.
   *   2. Thay đổi chỉ được ĐẨY VÀO HÀNG ĐỢI, chưa gửi đi.
   *   3. Sau 1,2 giây không có thao tác mới → gửi MỘT commit chứa toàn bộ
   *      các phép cộng đã gom.
   *
   * Nhờ vậy: bấm 10 lần liên tiếp = 1 write, không phải 10.
   *
   * TUYỆT ĐỐI KHÔNG:
   *   • đọc document rồi ghi lại cả document (1 read + 1 write + payload lớn,
   *     và có thể ghi đè star của thiết bị khác);
   *   • gửi từng lần bấm một (10 writes + 10 lần vượt ngưỡng 1 write/s/doc).
   */
  function addStar(featureId, groupId, studentId, n) {
    return changeStar(featureId, groupId, studentId, typeof n === "number" ? n : 1);
  }

  function removeStar(featureId, groupId, studentId, n) {
    return changeStar(featureId, groupId, studentId, -(typeof n === "number" ? n : 1));
  }

  function changeStar(featureId, groupId, studentId, delta) {
    if (!studentId) return Promise.reject(fail(new Error("NO_STUDENT")));
    if (!delta) return Promise.resolve();

    // ---- 1. Cập nhật lạc quan để UI phản hồi tức thì ----
    var g = localFind(featureId, groupId);
    if (g) {
      g.stars = g.stars || {};
      var cur = Number(g.stars[studentId] || 0);
      var next = Math.max(0, cur + delta);
      var real = next - cur;                    // delta thực sau khi kẹp về >= 0
      g.stars[studentId] = next;
      g.total = Math.max(0, Number(g.total || 0) + real);
      if (real === 0) return Promise.resolve(); // đã 0, không có gì để ghi
      delta = real;
    }
    emit(featureId);

    if (state.backend === "local") {
      localSave(featureId);
      return Promise.resolve();
    }

    // ---- 2. Đưa vào hàng đợi gộp ----
    queueDelta(featureId, groupId, studentId, delta);

    // ---- 3. Hẹn giờ gửi ----
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(function () {
      state.flushTimer = null;
      flush().catch(function (e) { warn("flush lỗi: " + e.message); });
    }, COALESCE_MS);

    return Promise.resolve();
  }

  function queueDelta(featureId, groupId, studentId, delta) {
    state.pending[featureId] = state.pending[featureId] || Object.create(null);
    var perGroup = state.pending[featureId][groupId] ||
                   (state.pending[featureId][groupId] = { stars: Object.create(null), total: 0 });

    perGroup.stars[studentId] = (perGroup.stars[studentId] || 0) + delta;
    perGroup.total += delta;
  }

  function clearPending(featureId, groupId) {
    if (!state.pending[featureId]) return;
    if (groupId) delete state.pending[featureId][groupId];
    else delete state.pending[featureId];
  }

  /**
   * flush() — gửi toàn bộ hàng đợi trong MỘT commit.
   *
   * Mỗi nhóm = 1 write. Mỗi write chứa nhiều `fieldTransforms`: một cho từng
   * học sinh được cộng, một cho `total`. Tất cả fieldTransforms trên CÙNG một
   * document vẫn chỉ tính là 1 document write.
   *
   * `increment` là phép cộng NGUYÊN TỬ phía server: không cần đọc trước, không
   * ghi đè thay đổi của thiết bị khác. Đây là điều kiện để "0 read".
   */
  function flush() {
    if (state.backend === "local") return Promise.resolve();
    if (state.flushing) return state.flushPromise || Promise.resolve();

    var featureIds = Object.keys(state.pending);
    if (!featureIds.length) return Promise.resolve();

    var writes = [];
    var sent = [];   // để hoàn tác nếu lỗi

    featureIds.forEach(function (featureId) {
      var perGroup = state.pending[featureId];
      Object.keys(perGroup).forEach(function (groupId) {
        var p = perGroup[groupId];
        var sid = Object.keys(p.stars);
        if (!sid.length && !p.total) return;

        var transforms = [];
        sid.forEach(function (studentId) {
          var v = p.stars[studentId];
          if (!v) return;
          // ★ ĐÂY LÀ DÒNG QUYẾT ĐỊNH: chỉ gửi một phép cộng trên một field,
          //   không gửi document. Payload ~45 byte cho mỗi field.
          transforms.push({
            fieldPath: "stars." + studentId,
            increment: { integerValue: String(v) }
          });
        });
        transforms.push({
          fieldPath: "total",
          increment: { integerValue: String(p.total) }
        });
        transforms.push({
          fieldPath: "updatedAt",
          setToServerValue: "REQUEST_TIME"
        });

        writes.push({
          transform: {
            document: fullName(groupPath(featureId, groupId)),
            fieldTransforms: transforms
          }
        });
        sent.push({ featureId: featureId, groupId: groupId, data: p });
      });
    });

    if (!writes.length) return Promise.resolve();

    // Ghi đè hàng đợi: thay đổi mới phát sinh trong lúc gửi sẽ vào hàng mới.
    state.pending = Object.create(null);
    state.flushing = true;

    var commitUrl = docRoot() + ":commit";
    var chunks = [];
    for (var i = 0; i < writes.length; i += MAX_WRITES_PER_COMMIT) {
      chunks.push(writes.slice(i, i + MAX_WRITES_PER_COMMIT));
    }

    var chain = Promise.resolve();
    chunks.forEach(function (chunk) {
      chain = chain.then(function () {
        return call("POST", commitUrl, { writes: chunk });
      });
    });

    state.flushPromise = chain.then(function () {
      state.flushing = false;
      status({ flushed: sent.length });
    }).catch(function (e) {
      state.flushing = false;
      // Gửi thất bại → trả lại hàng đợi để lần sau ghi tiếp (không mất star).
      sent.forEach(function (item) {
        Object.keys(item.data.stars).forEach(function (sid) {
          queueDelta(item.featureId, item.groupId, sid, item.data.stars[sid]);
        });
      });
      warn("commit thất bại, đã trả lại hàng đợi: " + e.message);
      throw fail(e);
    });

    return state.flushPromise;
  }

  /* ==========================================================================
   * 10. LISTENER REALTIME — CHỈ MỘT, TỰ HUỶ
   * ======================================================================== */

  /**
   * subscribe(featureId, onData) → hàm unsubscribe
   *
   * RÀNG BUỘC (quan trọng cho quota):
   *   • Toàn trang CHỈ có MỘT listener. Gọi subscribe lần nữa sẽ huỷ cái cũ.
   *   • Dùng truy vấn có WATERMARK (`updatedAt > mốc`): mỗi vòng poll chỉ trả về
   *     tài liệu THẬT SỰ đổi → 1 read/document đổi, không phải 6 reads mỗi vòng.
   *   • Nhịp tự giãn: 4 s khi đang sôi động → 15 s sau 2 phút rảnh.
   *   • Tạm dừng khi tab bị ẩn (document.hidden) → không tốn read vô ích.
   *   • Tự huỷ khi rời trang (pagehide) → không có listener mồ côi.
   */
  function subscribe(featureId, onData) {
    unsubscribe();   // đảm bảo chỉ 1 listener

    var L = {
      featureId: featureId,
      timer: null,
      watermark: null,
      lastChangeAt: Date.now(),
      stopped: false,
      inFlight: false,
      onData: onData || function () {}
    };
    state.listener = L;

    // Lần đầu: đọc toàn bộ (N reads, N = số nhóm) rồi lấy mốc thời gian.
    getGroups(featureId).then(function (list) {
      if (L.stopped) return;
      L.watermark = maxUpdatedAt(list);
      L.onData(list, { initial: true });
      schedule(L, POLL_FAST_MS);
    }).catch(function (e) { warn("subscribe init: " + e.message); });

    return function () { unsubscribe(); };
  }

  function maxUpdatedAt(list) {
    var m = null;
    (list || []).forEach(function (g) {
      var t = g.updatedAt;
      if (t && (!m || String(t) > String(m))) m = t;
    });
    return m || nowIso();
  }

  function schedule(L, ms) {
    if (L.stopped) return;
    if (L.timer) clearTimeout(L.timer);
    L.timer = setTimeout(function () { tick(L); }, ms);
  }

  function tick(L) {
    if (L.stopped) return;
    if (global.document && global.document.hidden) {
      // Tab đang ẩn → không poll. Khi tab hiện lại sẽ chạy ngay (xem bindVisibility).
      schedule(L, POLL_SLOW_MS);
      return;
    }
    if (L.inFlight) { schedule(L, POLL_FAST_MS); return; }

    L.inFlight = true;
    pollOnce(L).then(function (changed) {
      L.inFlight = false;
      if (L.stopped) return;
      var idle = Date.now() - L.lastChangeAt > POLL_IDLE_AFTER_MS;
      schedule(L, changed > 0 ? POLL_FAST_MS : (idle ? POLL_SLOW_MS : POLL_FAST_MS));
    }).catch(function (e) {
      L.inFlight = false;
      warn("poll lỗi: " + e.message);
      if (!L.stopped) schedule(L, POLL_SLOW_MS);   // lỗi → chậm lại, không spam
    });
  }

  /**
   * pollOnce(L) — một vòng poll có watermark.
   * QUOTA: 1 read nếu không có gì đổi; 1 read/document nếu có k document đổi.
   * (Truy vấn rỗng vẫn tính 1 read — vì vậy mới cần nhịp giãn.)
   */
  function pollOnce(L) {
    if (state.backend === "local") return Promise.resolve(0);

    var url = docRoot() + "/" + featurePath(L.featureId) + ":runQuery";
    var sq = {
      from: [{ collectionId: "groups" }],
      orderBy: [{ field: { fieldPath: "updatedAt" }, direction: "ASCENDING" }]
    };

    if (L.watermark) {
      sq.where = {
        fieldFilter: {
          field: { fieldPath: "updatedAt" },
          op: "GREATER_THAN",
          value: { timestampValue: L.watermark }
        }
      };
    }

    return call("POST", url, { structuredQuery: sq }).then(function (rows) {
      var changed = [];
      (rows || []).forEach(function (row) {
        if (row && row.document) changed.push(decFields(row.document));
      });

      if (!changed.length) return 0;

      // Gộp vào cache
      var list = state.groups[L.featureId] || [];
      changed.forEach(function (g) {
        var idx = -1;
        for (var i = 0; i < list.length; i++) if (list[i].id === g.id) { idx = i; break; }
        if (idx >= 0) list[idx] = g; else list.push(g);
      });
      list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      state.groups[L.featureId] = list;

      L.watermark = maxUpdatedAt(changed);
      L.lastChangeAt = Date.now();
      L.onData(list, { initial: false });
      return changed.length;
    });
  }

  /**
   * unsubscribe() — huỷ listener hiện tại. An toàn khi gọi nhiều lần.
   * Gọi hàm này khi rời trang / đổi tính năng / đăng xuất.
   */
  function unsubscribe() {
    var L = state.listener;
    if (!L) return;
    L.stopped = true;
    if (L.timer) clearTimeout(L.timer);
    L.timer = null;
    state.listener = null;
  }

  /**
   * flushNow() — gửi ngay hàng đợi (bỏ qua chờ 1,2 s).
   * Dùng khi: bấm "Lưu", rời trang, tab bị ẩn.
   */
  function flushNow() {
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    return flush();
  }

  /* ==========================================================================
   * 11. VÒNG ĐỜI TRANG — tự dọn dẹp
   * ======================================================================== */

  var lifecycleBound = false;

  function bindLifecycle() {
    if (lifecycleBound || typeof global.addEventListener !== "function") return;
    lifecycleBound = true;

    // Rời trang: gửi nốt star đang chờ + huỷ listener.
    // Dùng fetch keepalive để request kịp đi trước khi tab đóng.
    global.addEventListener("pagehide", function () {
      unsubscribe();
      if (state.backend === "firestore") {
        try { flush(); } catch (e) {}
      }
    });

    // Tab ẩn: gửi nốt rồi tạm dừng poll. Tab hiện: poll lại ngay.
    if (global.document) {
      global.document.addEventListener("visibilitychange", function () {
        if (global.document.hidden) {
          flushNow().catch(function () {});
          if (state.listener && state.listener.timer) {
            clearTimeout(state.listener.timer);
            state.listener.timer = null;
          }
        } else if (state.listener && !state.listener.stopped) {
          if (state.listener.timer) clearTimeout(state.listener.timer);
          tick(state.listener);
        }
      });
    }
  }

  /* ==========================================================================
   * 12. CHẾ ĐỘ LOCAL (dự phòng khi chưa cấu hình Firebase)
   * --------------------------------------------------------------------------
   * Cùng API, cùng cấu trúc dữ liệu → đổi sang Firebase không phải sửa UI.
   * Dữ liệu nằm trong localStorage của từng máy, không dùng chung được.
   * ======================================================================== */

  function localAll() {
    try { return JSON.parse(global.localStorage.getItem(LS_GROUPS) || "{}"); }
    catch (e) { return {}; }
  }
  function localKey(featureId) { return state.uid + "::" + featureId; }

  // Ghi đúng nhánh của feature hiện tại từ state.groups xuống localStorage.
  // (Nhận featureId để không ghi đè nhánh của tính năng khác trong cùng một key.)
  function localSave(featureId) {
    try {
      var all = localAll();
      all[localKey(featureId)] = state.groups[featureId] || [];
      global.localStorage.setItem(LS_GROUPS, JSON.stringify(all));
    } catch (e) { warn("localStorage đầy hoặc bị chặn"); }
  }

  function localGetGroups(featureId) {
    if (state.groups[featureId]) return state.groups[featureId];
    var all = localAll();
    var list = all[localKey(featureId)] || [];
    state.groups[featureId] = list;
    return list;
  }
  function localCreateGroup(featureId, gid, doc) {
    var list = localGetGroups(featureId);
    var g = Object.assign({ id: gid }, doc);
    list.push(g);
    localSave(featureId);
    return g;
  }
  function localDeleteGroup(featureId, groupId) {
    state.groups[featureId] = localGetGroups(featureId)
      .filter(function (g) { return g.id !== groupId; });
    localSave(featureId);
  }
  function localFind(featureId, groupId) {
    var list = state.groups[featureId] || localGetGroups(featureId);
    for (var i = 0; i < list.length; i++) if (list[i].id === groupId) return list[i];
    return null;
  }

  /* ==========================================================================
   * 13. ĐỒNG BỘ CACHE NỘI BỘ
   * ======================================================================== */

  function pushLocal(featureId, g) {
    var list = state.groups[featureId] || (state.groups[featureId] = []);
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === g.id) { idx = i; break; }
    if (idx >= 0) list[idx] = g; else list.push(g);
    list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  }

  function removeLocal(featureId, groupId) {
    var list = state.groups[featureId] || [];
    state.groups[featureId] = list.filter(function (g) { return g.id !== groupId; });
  }

  function emit(featureId) {
    var list = state.groups[featureId] || [];
    state.subscribers.forEach(function (cb) {
      try { cb(list, { local: true }); } catch (e) { warn("subscriber lỗi"); }
    });
    if (state.listener && state.listener.featureId === featureId &&
        typeof state.listener.onData === "function") {
      // listener cũng nhận cập nhật cục bộ để UI không bị "nhảy" về dữ liệu cũ
    }
  }

  /** onLocalChange(cb) → đăng ký nhận cập nhật lạc quan (không tốn read). */
  function onLocalChange(cb) {
    state.subscribers.push(cb);
    return function () {
      state.subscribers = state.subscribers.filter(function (f) { return f !== cb; });
    };
  }

  /* ==========================================================================
   * 14. TIỆN ÍCH CHO UI
   * ======================================================================== */

  /** Tổng star của cả lớp (tính từ cache, 0 read). */
  function classTotal(featureId) {
    return (state.groups[featureId] || []).reduce(function (s, g) {
      return s + Number(g.total || 0);
    }, 0);
  }

  /** Giáo viên đang đăng nhập chưa? (dùng để chặn UI) */
  function isSignedIn() { return Boolean(state.userName); }

  /** Đăng xuất: dọn sạch listener + hàng đợi + phiên. */
  function signOut() {
    unsubscribe();
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    try {
      global.localStorage.removeItem(SESSION_KEY);
      global.localStorage.removeItem("tt_fb_token");
    } catch (e) {}
    state.pending = Object.create(null);
    state.groups = Object.create(null);
  }

  /* ==========================================================================
   * 15. XUẤT MODULE
   * ======================================================================== */

  var TTDB = {
    // khởi tạo
    init: init,
    ready: function () { return state.ready; },
    backend: function () { return state.backend; },
    uid: function () { return state.uid; },
    isSignedIn: isSignedIn,
    signOut: signOut,

    // đọc
    getGroups: getGroups,
    getGroup: getGroup,
    classTotal: classTotal,

    // nhóm
    createGroup: createGroup,
    deleteGroup: deleteGroup,
    renameGroup: renameGroup,

    // học sinh
    addStudent: addStudent,
    removeStudent: removeStudent,

    // star — tối ưu quota
    addStar: addStar,
    removeStar: removeStar,
    flushNow: flushNow,

    // realtime
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    onLocalChange: onLocalChange,

    // hook cho UI
    onError: function (fn) { state.onError = fn; },
    onStatus: function (fn) { state.onStatus = fn; },

    // cho test
    _state: state,
    _randId: randId,
    _enc: enc,
    _dec: dec,
    _COALESCE_MS: COALESCE_MS
  };

  global.TTDB = TTDB;

  // Tự gắn vòng đời trang ngay khi nạp script.
  bindLifecycle();

})(typeof window !== "undefined" ? window : this);
