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
  var LS_META     = "tt_meta_v1";       // khung trường/lớp (chỉ dùng ở chế độ local)

  // Gộp thao tác: mọi thay đổi trong khoảng này thành 1 commit duy nhất.
  // 1200 ms là điểm cân bằng: người dùng vẫn thấy phản hồi tức thì (UI cập nhật
  // lạc quan), nhưng 10 lần bấm liên tiếp chỉ tốn 1 write thay vì 10.
  var COALESCE_MS = 1200;

  // Nhịp poll listener. Nhanh khi vừa có thay đổi, giãn ra khi rảnh.
  //
  // ⚡ VIỆC 2 (tối ưu quota): 4000 → 15000 ms.
  // Vòng poll là khoản chi LỚN NHẤT của tính năng: một truy vấn rỗng vẫn tính 1 read,
  // nên ở nhịp 4 s một tiết 45 phút tốn ~675 reads chỉ để hỏi "có gì mới không" —
  // chiếm ~88 % tổng reads. Ở 15 s còn ~180 reads/tiết (−64 %).
  // Đánh đổi: máy thứ hai thấy star mới chậm hơn tối đa 15 s thay vì 4 s —
  // không ai nhận ra với một bảng điểm trên lớp.
  var POLL_FAST_MS  = 15000;
  var POLL_SLOW_MS  = 30000;            // giãn tiếp khi đã rảnh > 2 phút
  var POLL_IDLE_AFTER_MS = 120000;      // sau 2 phút không đổi → chuyển nhịp chậm

  // ⚡ VIỆC 3 (tối ưu quota): cache danh sách nhóm trong sessionStorage.
  // Mỗi lần F5 là N reads (N = tổng số nhóm của MỌI lớp). Với 5 lớp × 6 nhóm = 30 reads
  // cho một lần tải lại. Cache này cắt phần lớn số đó khi giáo viên F5 liên tục
  // trong cùng một phiên tab (vd đang soạn bài, mở lại nhiều lần).
  //
  // VÌ SAO sessionStorage chứ KHÔNG localStorage?
  //   • sessionStorage sống theo TAB → đóng tab là hết, không để lại dữ liệu cũ
  //     trên máy dùng chung (phòng máy của trường).
  //   • Nhiều tab = nhiều cache riêng, không giẫm lên nhau.
  //
  // AN TOÀN: cache KHÔNG BAO GIỜ là nguồn sự thật lâu dài — TTL chỉ 60 s, mọi thao tác
  // ghi đều cập nhật lại cache ngay, và mất cache chỉ tốn thêm reads (không mất dữ liệu).
  var GROUPS_CACHE_TTL_MS = 60000;
  var LS_CACHE = "tt_cache_v1";

  // ⚡ VIỆC 3: cache khung trường/lớp trong bộ nhớ (state.meta) — TTL 30 s.
  // Trước đây getHierarchy() LUÔN gọi mạng, nên mỗi thao tác phân cấp tốn 2 reads
  // (hàm đọc 1 lần, UI đọc lại 1 lần). Dùng cache thì còn 1.
  var HIER_CACHE_TTL_MS = 30000;

  // Bộ đếm quota: TẮT mặc định. Bật bằng ?debug=quota hoặc localStorage.tt_quota=1.
  var QUOTA_LS_KEY = "tt_quota";

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
    // refreshToken của Firebase — dùng để lấy idToken mới khi token cũ hết hạn (3600 s).
    refreshToken: null,
    userName:  null,

    // cache nhóm theo featureId -> array<group>
    groups:    Object.create(null),

    // cache khung trường/lớp theo featureId -> { schools: [...], updatedAt }
    meta:      Object.create(null),

    // mốc thời gian (ms) của lần ĐỌC MẠNG gần nhất cho meta[featureId]
    // → dùng để quyết định có trả cache hay gọi lại getHierarchy().
    metaAt:    Object.create(null),

    // mốc thời gian (ms) của lần ghi cache nhóm gần nhất theo featureId
    groupsAt:  Object.create(null),

    // hàng đợi ghi đang chờ gộp: featureId -> groupId -> { stars:{sid:delta}, total:delta }
    pending:   Object.create(null),

    flushTimer: null,
    flushing:   false,

    // listener
    listener:   null,         // { featureId, timer, onData, watermark, lastChangeAt, stopped, inFlight }
    subscribers: [],          // callback người dùng đăng ký
    metaSubscribers: [],      // callback khi khung trường/lớp thay đổi
    metaLocalOnly: false,     // true = rules chưa cho ghi meta → dùng cache máy

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
      // index.html ghi khoá `exp`, bản cũ của db.js đọc `ex` → chấp nhận cả hai.
      var exp = s.exp || s.ex;
      if (exp && Date.now() > exp) return null;   // hết hạn
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
    // CHỈ dùng đường dẫn tuyệt đối từ gốc site.
    // Trước đây có thêm "api/config.js" (tương đối) làm dự phòng, nhưng khi trang
    // nằm ở /features/star-race/ thì nó trỏ tới /features/star-race/api/config.js
    // → luôn 404 và làm bẩn Console. Trên Vercel /api/config.js đã đúng.
    var paths = ["/api/config.js"];
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
    state.refreshToken = sess ? (sess.rt || "") : "";

    // Bộ đếm quota: quyết định bật/tắt MỘT LẦN ở đây. Tắt thì mọi hàm đếm
    // return ngay, không tốn gì.
    quota.on = quotaEnabled();
    if (quota.on) {
      quotaReset();
      if (global.document) {
        if (global.document.body) quotaMount();
        else global.document.addEventListener("DOMContentLoaded", quotaMount);
      }
    }

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

  /* ==========================================================================
   * 5a. BỘ ĐẾM QUOTA  (TẮT MẶC ĐỊNH)
   * --------------------------------------------------------------------------
   * Đếm ĐÚNG đơn vị mà Firestore tính tiền, không phải số request:
   *   • read  = số DOCUMENT trả về (runQuery rỗng vẫn tính 1 — đúng như
   *             Firestore: một truy vấn không khớp gì vẫn là 1 document read).
   *   • write = số DOCUMENT trong mỗi :commit (mỗi document 1 write, dù có
   *             bao nhiêu fieldTransform trên nó), hoặc 1 cho PATCH/POST/DELETE.
   *   • KB    = tổng byte response (egress) + byte request.
   *
   * BẬT: ?debug=quota trên URL, hoặc localStorage.tt_quota = "1".
   * TẮT: không có gì chạy — mọi hàm dưới đây return ngay ở dòng đầu, không
   *      cấp phát object, không đụng DOM, không thêm read/write nào.
   * ========================================================================== */

  var quota = {
    on: false,
    reads: 0,
    writes: 0,
    deletes: 0,
    bytesIn: 0,
    bytesOut: 0,
    polls: 0,
    cacheHits: 0,
    cacheMiss: 0,
    requests: 0,
    byOp: Object.create(null),   // op -> { reads, writes, bytes }
    startedAt: 0
  };

  function quotaEnabled() {
    try {
      if (global.location && /[?&]debug=quota\b/.test(global.location.search || "")) return true;
      if (global.localStorage && global.localStorage.getItem(QUOTA_LS_KEY) === "1") return true;
    } catch (e) { /* chế độ riêng tư → coi như tắt */ }
    return false;
  }

  function quotaReset() {
    quota.reads = 0; quota.writes = 0; quota.deletes = 0;
    quota.bytesIn = 0; quota.bytesOut = 0;
    quota.polls = 0; quota.cacheHits = 0; quota.cacheMiss = 0;
    quota.requests = 0;
    quota.byOp = Object.create(null);
    quota.startedAt = Date.now();
  }

  /** Ghi nhận một phép đo. `op` là nhãn nghiệp vụ: "open", "poll", "star"... */
  function quotaAdd(op, reads, writes, bytesIn, bytesOut) {
    if (!quota.on) return;
    var r = reads || 0, w = writes || 0;
    quota.reads += r;
    quota.writes += w;
    quota.bytesIn += bytesIn || 0;
    quota.bytesOut += bytesOut || 0;
    quota.requests += 1;

    var key = op || "other";
    var b = quota.byOp[key] || (quota.byOp[key] = { reads: 0, writes: 0, bytes: 0, n: 0 });
    b.reads += r; b.writes += w; b.bytes += (bytesIn || 0) + (bytesOut || 0); b.n += 1;
  }

  /** Nhãn nghiệp vụ đang chạy — UI/hàm gọi đặt trước khi gọi mạng. */
  var quotaOp = "other";
  function quotaSetOp(op) { if (quota.on) quotaOp = op || "other"; }

  /** Đếm số document trong một response runQuery. */
  function countQueryDocs(data) {
    if (!Array.isArray(data)) return 0;
    var n = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i] && data[i].document) n++;
    }
    // Truy vấn không khớp document nào VẪN tính 1 read (đúng chính sách Firestore).
    return n > 0 ? n : 1;
  }

  /** Đếm số document bị ghi trong một :commit. */
  function countCommitWrites(body) {
    if (!body || !Array.isArray(body.writes)) return 0;
    return body.writes.length;
  }

  /* ==========================================================================
   * 5c. OVERLAY QUOTA  (chỉ dựng khi bật debug)
   * --------------------------------------------------------------------------
   * Không đụng DOM khi tắt. Khi bật: một bảng nhỏ ở góc dưới-trái, tự cập nhật
   * mỗi 1 s, có nút Reset. Dùng position:fixed + z-index cao nhưng pointer-events
   * chỉ bật trên chính bảng → không chặn thao tác của giáo viên.
   * ========================================================================== */

  var quotaEl = null;

  function quotaSnapshot() {
    var kb = (quota.bytesIn + quota.bytesOut) / 1024;
    return {
      reads: quota.reads,
      writes: quota.writes,
      deletes: quota.deletes,
      kb: Math.round(kb * 10) / 10,
      polls: quota.polls,
      cacheHits: quota.cacheHits,
      cacheMiss: quota.cacheMiss,
      requests: quota.requests,
      byOp: quota.byOp
    };
  }

  function quotaRender() {
    if (!quotaEl) return;
    var s = quotaSnapshot();
    var rows = "";
    Object.keys(s.byOp).sort().forEach(function (k) {
      var b = s.byOp[k];
      rows += "<tr><td>" + k + "</td><td>" + b.reads + "</td><td>" + b.writes +
              "</td><td>" + Math.round(b.bytes / 1024 * 10) / 10 + "</td></tr>";
    });
    quotaEl.innerHTML =
      '<div style="font:600 12px/1.4 system-ui,sans-serif;margin-bottom:4px">' +
        '📊 Quota Firestore <span style="font-weight:400;opacity:.6">(debug)</span>' +
      '</div>' +
      '<div style="font:12px/1.5 system-ui,sans-serif">' +
        'reads <b>' + s.reads + '</b> · writes <b>' + s.writes + '</b> · ' +
        s.kb + ' KB<br>' +
        'poll <b>' + s.polls + '</b> · cache hit <b>' + s.cacheHits + '</b> / miss ' + s.cacheMiss +
      '</div>' +
      '<table style="font:11px/1.4 system-ui,sans-serif;border-collapse:collapse;margin-top:4px">' +
        '<tr style="opacity:.6"><th align="left">op</th><th>r</th><th>w</th><th>KB</th></tr>' +
        rows +
      '</table>' +
      '<button id="ttq-reset" style="margin-top:5px;font:11px system-ui;padding:2px 7px;' +
        'border:1px solid #bbb;border-radius:5px;background:#fff;cursor:pointer">Reset</button>';
    var btn = quotaEl.querySelector("#ttq-reset");
    if (btn) btn.onclick = function () { quotaReset(); quotaRender(); };
  }

  function quotaMount() {
    if (!quota.on || quotaEl || !global.document || !global.document.body) return;
    quotaEl = global.document.createElement("div");
    quotaEl.id = "tt-quota-overlay";
    quotaEl.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:2147483000;background:rgba(255,255,255,.96);" +
      "border:1px solid #d7dbe0;border-radius:9px;padding:7px 9px;box-shadow:0 3px 12px rgba(0,0,0,.13);" +
      "max-width:250px;color:#1f2937;pointer-events:auto";
    global.document.body.appendChild(quotaEl);
    quotaRender();
    global.setInterval(quotaRender, 1000);
  }

  /* --------------------------------------------------------------------------
   * LÀM MỚI idToken
   * --------------------------------------------------------------------------
   * idToken của Firebase CHỈ sống 3600 giây, trong khi phiên đăng nhập được lưu
   * 30 ngày. Trước đây app không hề làm mới token: sau đúng 1 giờ, mọi lệnh
   * Firestore trả 401 UNAUTHENTICATED và tính năng "Chấm điểm nhóm" rơi vào
   * trạng thái mất đồng bộ (dữ liệu không còn lên mây) cho tới khi đăng nhập lại.
   *
   * Hàm dưới đây đổi refreshToken lấy idToken mới qua Secure Token API, ghi lại
   * phiên trong localStorage, rồi để call() thử lại request đúng MỘT lần.
   * Nhiều request cùng bị 401 một lúc sẽ dùng chung MỘT lần refresh.
   */
  var refreshing = null;

  function refreshIdToken() {
    if (refreshing) return refreshing;
    var rt = state.refreshToken;
    if (!rt || !state.apiKey) return Promise.reject(new Error("NO_REFRESH_TOKEN"));

    refreshing = fetch("https://securetoken.googleapis.com/v1/token?key=" +
                       encodeURIComponent(state.apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(rt),
      cache: "no-store"
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d || !d.id_token) {
          var e = new Error((d && d.error && d.error.message) || ("HTTP_" + r.status));
          e.status = r.status;
          throw e;
        }
        state.token = d.id_token;
        if (d.refresh_token) state.refreshToken = d.refresh_token;
        // Ghi lại phiên để lần F5 sau dùng luôn token mới.
        try {
          var raw = global.localStorage.getItem(SESSION_KEY);
          var s = raw ? JSON.parse(raw) : null;
          if (s) {
            s.t = state.token;
            if (d.refresh_token) s.rt = d.refresh_token;
            s.at = Date.now();
            global.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
          }
        } catch (e2) { /* localStorage bị chặn → vẫn dùng token trong bộ nhớ */ }
        return state.token;
      });
    });

    refreshing = refreshing.then(function (t) { refreshing = null; return t; },
                                 function (e) { refreshing = null; throw e; });
    return refreshing;
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
    // ⚡ VIỆC 1: keepalive để request kịp rời máy khi tab đóng.
    // Trên `pagehide` trình duyệt sẽ huỷ mọi fetch đang bay → những star cuối cùng
    // (đang chờ gộp 1,2 s) bị MẤT. `keepalive: true` cho phép request sống tiếp
    // sau khi trang đã đóng (giới hạn 64 KB tổng — payload của ta ~45 B/field nên thoải mái).
    //
    // CHỈ bật cho các method GHI: GET/poll không cần sống sót sau khi tab đóng,
    // và keepalive không dùng được chung với cache no-store ở một số trình duyệt cũ.
    if (method !== "GET") opt.keepalive = true;
    if (body !== undefined) opt.body = JSON.stringify(body);

    // Bộ đếm quota: đo byte request (chỉ khi bật).
    var reqBytes = 0;
    if (quota.on) {
      reqBytes = (opt.body ? opt.body.length : 0) + url.length;
    }

    return fetch(url, opt).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }

        // ---- Bộ đếm quota: quy đổi response thành read/write ----
        if (quota.on) {
          var resBytes = txt ? txt.length : 0;
          var isQuery = /:runQuery$/.test(url);
          var isCommit = /:commit$/.test(url);
          var rd = 0, wr = 0;

          if (r.ok) {
            if (isQuery) {
              rd = countQueryDocs(data);
            } else if (isCommit) {
              wr = countCommitWrites(body);
            } else if (method === "GET") {
              rd = 1;                       // đọc 1 document
            } else if (method === "DELETE") {
              wr = 1;
              quota.deletes += 1;
            } else {
              wr = 1;                       // PATCH / POST
            }
          }
          quotaAdd(quotaOp, rd, wr, reqBytes, resBytes);
        }

        if (r.ok) return data;

        var code = (data && data.error && data.error.status) || ("HTTP_" + r.status);

        // idToken hết hạn (3600 s) → Firestore trả 401 UNAUTHENTICATED.
        // Làm mới token rồi thử lại ĐÚNG MỘT lần (attempt < 1 để không lặp vô hạn).
        if ((r.status === 401 || code === "UNAUTHENTICATED") && attempt < 1) {
          return refreshIdToken().then(function () {
            return call(method, url, body, attempt + 1);
          }).catch(function (re) {
            // Phiên cũ (tạo trước bản vá) không có refreshToken, hoặc refreshToken
            // đã bị thu hồi → không thể tự phục hồi. Xoá phiên và đưa về trang
            // đăng nhập thay vì để app chạy tiếp trong trạng thái mất đồng bộ.
            var rc = (re && (re.message || re.code)) || "";
            if (rc === "NO_REFRESH_TOKEN" || rc === "INVALID_REFRESH_TOKEN" ||
                rc === "TOKEN_EXPIRED" || rc === "USER_DISABLED" ||
                rc === "USER_NOT_FOUND" || (re && re.status === 400)) {
              try { global.localStorage.removeItem(SESSION_KEY); } catch (e3) {}
              state.token = null;
              state.refreshToken = null;
              if (global.location && /\/features\//.test(global.location.pathname)) {
                global.location.replace("/");
              }
            }
            throw re;
          });
        }

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

  /**
   * ensureFeatureParent(featureId) → Promise
   *
   * Firestore KHÔNG có khái niệm "thư mục": một document con có thể tồn tại mà
   * cha không tồn tại. Nhưng firestore.rules ở đây yêu cầu `isOwner(uid)`, mà
   * điều đó CHỈ đúng khi đường dẫn đi qua `users/{uid}` — vốn luôn đúng vì uid
   * nằm trong chính đường dẫn. Vì vậy không cần ghi document cha.
   *
   * Hàm này giữ lại như một điểm móc: nếu sau này rules yêu cầu
   * `exists(/users/{uid}/features/{featureId})` thì chỉ cần bật REQUIRE_PARENT.
   */
  var REQUIRE_PARENT = false;

  function ensureFeatureParent(featureId) {
    if (!REQUIRE_PARENT) return Promise.resolve();
    var url = docRoot() + "/" + featurePath(featureId) +
              "?updateMask.fieldPaths=createdAt";
    return call("PATCH", url, {
      fields: { createdAt: { timestampValue: nowIso() } }
    }).catch(function () { /* đã tồn tại / không quan trọng */ });
  }

  /* ==========================================================================
   * 5b. CACHE sessionStorage CHO DANH SÁCH NHÓM  (⚡ VIỆC 3)
   * --------------------------------------------------------------------------
   * Đọc/ghi cache của MỘT featureId. Mọi lỗi (chế độ riêng tư, đầy quota,
   * JSON hỏng) đều được NUỐT LẶNG → mất cache chỉ tốn thêm reads, không bao giờ
   * làm hỏng trang.
   *
   * Key gồm uid + featureId để hai tài khoản trên cùng máy không thấy dữ liệu
   * của nhau (sessionStorage vốn riêng theo tab, nhưng vẫn tách cho chắc).
   * ========================================================================== */

  function cacheKey(featureId) {
    return LS_CACHE + "::" + (state.uid || "?") + "::" + featureId;
  }

  function readGroupsCache(featureId) {
    try {
      if (!global.sessionStorage) return null;
      var raw = global.sessionStorage.getItem(cacheKey(featureId));
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.t || !Array.isArray(obj.list)) return null;

      // Còn hạn → dùng luôn. Nạp cả vào state.groups để phần còn lại của db.js
      // (lọc theo lớp, renameClassEverywhere...) thấy dữ liệu NGAY, không phải
      // chờ một request mạng.
      if (Date.now() - obj.t < GROUPS_CACHE_TTL_MS) {
        state.groups[featureId] = obj.list;
        state.groupsAt[featureId] = obj.t;
        return obj.list;
      }
      // Hết hạn → dọn luôn cho nhẹ storage.
      global.sessionStorage.removeItem(cacheKey(featureId));
    } catch (e) { /* bỏ qua: cache chỉ là tối ưu */ }
    return null;
  }

  /** Ghi cache + cập nhật state.groups. Gọi ở MỌI chỗ danh sách nhóm thay đổi. */
  function setGroupsCache(featureId, list) {
    var now = Date.now();
    // Chế độ Local cũng phải cập nhật state.groups — nếu không, xoá/thêm nhóm ở
    // chế độ Local sẽ không thấy đổi trong bộ nhớ (chỉ localStorage mới đổi).
    state.groups[featureId] = list;
    state.groupsAt[featureId] = now;
    if (state.backend !== "firestore") return;
    try {
      if (!global.sessionStorage) return;
      global.sessionStorage.setItem(cacheKey(featureId),
        JSON.stringify({ t: now, list: list }));
    } catch (e) { /* đầy quota / chế độ riêng tư → bỏ qua */ }
  }

  /** Xoá cache của một feature — dùng khi đăng xuất hoặc cần ép đọc lại từ mạng. */
  function clearGroupsCache(featureId) {
    try {
      if (!global.sessionStorage) return;
      if (featureId) global.sessionStorage.removeItem(cacheKey(featureId));
      else {
        // Xoá mọi key của cache này (dùng khi đăng xuất).
        for (var i = global.sessionStorage.length - 1; i >= 0; i--) {
          var k = global.sessionStorage.key(i);
          if (k && k.indexOf(LS_CACHE + "::") === 0) global.sessionStorage.removeItem(k);
        }
      }
    } catch (e) { /* bỏ qua */ }
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
    quotaSetOp("open");

    // ⚡ VIỆC 3: trả cache sessionStorage nếu còn hạn (0 read).
    var hit = readGroupsCache(featureId);
    if (hit) {
      if (quota.on) quota.cacheHits += 1;
      return Promise.resolve(hit);
    }
    if (quota.on) quota.cacheMiss += 1;

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
      setGroupsCache(featureId, list);
      return list;
    }).catch(function (e) {
      // Không đọc được (mạng / quyền) → trả cache cũ nếu có, đừng làm sập UI
      warn("getGroups lỗi: " + e.message);
      // Chỉ trả cache khi đúng là MẢNG — trước đây trả về bất kỳ thứ gì có trong
      // state.groups, khiến subscribe() gọi .forEach trên object và ném
      // "(list || []).forEach is not a function".
      if (Array.isArray(state.groups[featureId])) return state.groups[featureId];
      return fail(e);
    });
  }

  /* ==========================================================================
   * 6b. PHÂN CẤP TRƯỜNG → LỚP  (tối ưu quota: 1 read + 1 write)
   * --------------------------------------------------------------------------
   * MỘT GIÁO VIÊN DẠY NHIỀU TRƯỜNG, NHIỀU LỚP.
   * Chọn cấu trúc HYBRID (xem docs/firestore-schema.md mục 2b):
   *
   *   1) GOM NHÓM THEO LỚP  → ghi thẳng schoolId/classId vào document nhóm
   *      (denormalized). Nhờ vậy mở một lớp = 0 read thêm: danh sách nhóm đã
   *      tải một lần, lọc theo classId ngay trong bộ nhớ.
   *
   *   2) DANH MỤC TRƯỜNG/LỚP → một document duy nhất
   *      users/{uid}/features/{featureId}/meta/hierarchy
   *      { schools:[{id,name,order,classes:[{id,name,order}]}], updatedAt }
   *      Cần document này vì trường/lớp phải TỒN TẠI được cả khi CHƯA có nhóm
   *      nào (bấm "Tạo trường" xong phải thấy trường đó ngay). Nếu suy ra danh
   *      sách từ chính các nhóm thì trường rỗng sẽ biến mất — không dùng được.
   *
   * TẠI SAO KHÔNG DÙNG SUBCOLLECTION LỒNG SÂU?
   *   users/{uid}/.../schools/{sid}/classes/{cid}/groups/{gid}
   *   → mở một lớp tốn 3 tầng truy vấn = 3 reads + N; tạo nhóm phải ghi 3 chỗ;
   *     xoá lớp phải xoá N+ document. Ở đây: mở lớp = 1 meta read dùng chung cho
   *     MỌI lớp, mở lại trang = N + 1 reads (không phụ thuộc số trường/lớp).
   *
   * KHÔNG CÒN BUCKET "Chưa phân loại": nhóm chưa có schoolId/classId được gán vào
   *   TRƯỜNG THẬT ĐẦU TIÊN (do UI thực hiện, xem assignOrphans trong index.html).
   *   Module này không bao giờ tự sinh ra trường ảo nữa.
   * ========================================================================== */

  var META_DOC_PATH = function (featureId) {
    return featurePath(featureId) + "/meta/hierarchy";
  };

  /**
   * TRƯỜNG/LỚP: KHÔNG còn bucket kỹ thuật "Chưa phân loại".
   *
   * Trước đây mọi nhóm chưa có schoolId/classId được quy về một cặp ảo
   * sch_default / cls_default ("Chưa phân loại" / "Chưa xếp lớp"). Cặp đó hiện ra
   * như một TRƯỜNG THẬT trong màn "Chọn trường", không xoá được, không đổi tên
   * được, và nuốt mọi nhóm cũ vào một chỗ không ai quản lý.
   *
   * Nay module này KHÔNG tự sinh trường ảo. Danh mục rỗng nghĩa là rỗng thật, và
   * UI sẽ mời giáo viên tạo trường đầu tiên. Nhóm chưa phân cấp được UI gán vào
   * trường thật đầu tiên (xem assignOrphans trong features/star-race/index.html).
   */

  /** Một khung RỖNG THẬT — không còn trường/lớp ảo nào để nhóm cũ rơi vào. */
  function emptyHierarchy() {
    return { schools: [], updatedAt: null };
  }

  /** Chuẩn hoá dữ liệu meta đọc từ Firestore/localStorage → hình dạng an toàn. */
  function normalizeHierarchy(raw) {
    var out = { schools: [], updatedAt: (raw && raw.updatedAt) || null };
    var schools = (raw && Array.isArray(raw.schools)) ? raw.schools : [];

    schools.forEach(function (s, i) {
      if (!s || typeof s !== "object" || !s.id) return;
      var classes = [];
      (Array.isArray(s.classes) ? s.classes : []).forEach(function (c, j) {
        if (!c || typeof c !== "object" || !c.id) return;
        classes.push({
          id: String(c.id),
          name: String(c.name || "Lớp").slice(0, 60),
          order: typeof c.order === "number" ? c.order : (j + 1)
        });
      });
      out.schools.push({
        id: String(s.id),
        name: String(s.name || "Trường").slice(0, 60),
        order: typeof s.order === "number" ? s.order : (i + 1),
        classes: classes
      });
    });

    // Không chèn trường/lớp ảo nữa: danh mục rỗng thì trả về rỗng.

    out.schools.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    out.schools.forEach(function (s) {
      s.classes.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    });
    return out;
  }

  /**
   * getHierarchy(featureId) → Promise<{schools, updatedAt}>
   *
   * QUOTA: 1 read cho TOÀN BỘ trường + lớp của một tính năng, dùng chung cho mọi
   * lần mở lớp. Không phải 1 read/trường hay 1 read/lớp.
   */
  function getHierarchy(featureId) {
    if (state.backend === "local") return Promise.resolve(localGetHierarchy(featureId));
    quotaSetOp("hierarchy");

    // ⚡ VIỆC 3: dùng cache bộ nhớ nếu vừa đọc trong HIER_CACHE_TTL_MS.
    // Trước đây hàm này LUÔN gọi mạng nên mỗi thao tác phân cấp tốn 2 reads
    // (hàm đọc 1 lần, UI gọi getHierarchy() thêm 1 lần để lấy khung mới).
    // Cache 30 s đủ bọc trọn một thao tác tạo/đổi tên/xoá trường-lớp.
    // LƯU Ý: KHÔNG cache khi đang metaLocalOnly — lúc đó nguồn sự thật là
    // localStorage, và localGetHierarchy() đã là 0 read nên không cần.
    var cachedAt = state.metaAt[featureId];
    if (!state.metaLocalOnly && state.meta[featureId] && cachedAt &&
        (Date.now() - cachedAt) < HIER_CACHE_TTL_MS) {
      return Promise.resolve(state.meta[featureId]);
    }

    var url = docRoot() + "/" + META_DOC_PATH(featureId);
    return call("GET", url).then(function (doc) {
      var data = decFields(doc);
      var h = normalizeHierarchy(data);
      state.meta[featureId] = h;
      state.metaAt[featureId] = Date.now();
      state.metaLocalOnly = false;
      return h;
    }).catch(function (e) {
      var c = (e && (e.code || e.message)) || "";
      // Chưa có document meta (lần đầu dùng) → thử cache máy rồi trả khung rỗng,
      // KHÔNG báo lỗi.
      if (c === "NOT_FOUND" || c === "HTTP_404" ||
          c === "PERMISSION_DENIED" || c === "HTTP_403") {
        var cached = localGetHierarchy(featureId);
        var h = cached.schools && cached.schools.length ? cached : emptyHierarchy();
        if (c === "PERMISSION_DENIED" || c === "HTTP_403") state.metaLocalOnly = true;
        state.meta[featureId] = h;
        state.metaAt[featureId] = Date.now();
        return h;
      }
      warn("getHierarchy lỗi: " + e.message);
      if (state.meta[featureId]) return state.meta[featureId];
      return fail(e);
    });
  }

  /**
   * saveHierarchy(featureId, h) → Promise<void>
   *
   * QUOTA: 1 write. Ghi CẢ mảng schools trong một PATCH có updateMask.
   *
   * ĐÁNH ĐỔI: mỗi lần tạo/đổi tên/xoá trường hoặc lớp là 1 write ghi lại toàn
   * bộ khung (~0,3 KB với 3 trường × 6 lớp). Vì thao tác này rất hiếm (đầu năm
   * học) nên rẻ hơn nhiều so với việc tách mỗi trường/lớp thành document riêng
   * (mỗi lần mở trang sẽ tốn thêm 1 read/trường).
   *
   * SUY GIẢM MỀM: nếu rules CHƯA deploy (403 PERMISSION_DENIED cho meta), ta vẫn
   * lưu khung vào localStorage để UI dùng được ngay, và bật cờ metaLocalOnly.
   * Dữ liệu QUAN TRỌNG (nhóm + học sinh + star + schoolId/classId) vẫn nằm trên
   * Firestore bình thường — chỉ danh mục trường/lớp là tạm cục bộ.
   */
  function saveHierarchy(featureId, h) {
    quotaSetOp("hierarchy-save");
    var clean = normalizeHierarchy(h);
    clean.updatedAt = nowIso();
    state.meta[featureId] = clean;
    // Ghi xong thì coi như cache vừa được làm mới (mình vừa là nguồn sự thật).
    state.metaAt[featureId] = Date.now();

    if (state.backend === "local") {
      localSaveHierarchy(featureId, clean);
      emitMeta(featureId);
      return Promise.resolve(clean);
    }

    var url = docRoot() + "/" + META_DOC_PATH(featureId) +
              "?updateMask.fieldPaths=schools&updateMask.fieldPaths=updatedAt";
    var body = {
      fields: {
        schools:   enc(clean.schools),
        updatedAt: { timestampValue: clean.updatedAt }
      }
    };
    return call("PATCH", url, body).then(function () {
      state.metaLocalOnly = false;
      emitMeta(featureId);
      return clean;
    }).catch(function (e) {
      var c = e && (e.code || e.message);
      // Rules chưa deploy → cho tính năng chạy tiếp bằng cache máy.
      if (c === "PERMISSION_DENIED" || c === "HTTP_403") {
        state.metaLocalOnly = true;
        localSaveHierarchy(featureId, clean);
        warn("meta/hierarchy bị 403 — đang lưu danh mục trường/lớp tạm trên máy. " +
             "Deploy firestore.rules để đồng bộ giữa các thiết bị.");
        emitMeta(featureId);
        return clean;
      }
      warn("saveHierarchy lỗi: " + e.message);
      throw fail(e);
    });
  }

  /** ID an toàn cho trường/lớp: chữ thường + số + "_" (khớp isSafeId trong rules). */
  function hierId(prefix) { return randId(prefix); }

  /**
   * createSchool(featureId, name) → Promise<school>   QUOTA: 1 write
   * Tên trùng (không phân biệt hoa/thường) → dùng lại trường đã có, 0 write.
   */
  function createSchool(featureId, name) {
    var sname = String(name || "").trim().slice(0, 60);
    if (!sname) return Promise.reject(fail(new Error("EMPTY_NAME")));

    return getHierarchy(featureId).then(function (h) {
      var low = sname.toLowerCase();
      var found = h.schools.filter(function (s) {
        return String(s.name).toLowerCase() === low;
      })[0];

      if (found) {
        // Đã có → bổ sung lớp mặc định cho trường này, 1 write.
        if (!found.classes.length) {
          found.classes.push({ id: hierId("cls_"), name: "Lớp 1", order: 1 });
          return saveHierarchy(featureId, h).then(function () { return found; });
        }
        return Promise.resolve(found);
      }

      var maxOrder = 0;
      h.schools.forEach(function (s) {
        maxOrder = Math.max(maxOrder, s.order || 0);
      });

      var school = {
        id: hierId("sch_"),
        name: sname,
        order: maxOrder + 1,
        // Tạo trường là có luôn một lớp trống để giáo viên bấm vào ngay,
        // không phải làm thêm một bước. Vẫn 1 write.
        classes: [{ id: hierId("cls_"), name: "Lớp 1", order: 1 }]
      };
      h.schools.push(school);
      return saveHierarchy(featureId, h).then(function () { return school; });
    });
  }

  /**
   * createClass(featureId, schoolId, name) → Promise<class>   QUOTA: 1 write
   */
  function createClass(featureId, schoolId, name) {
    var cname = String(name || "").trim().slice(0, 60);
    if (!cname) return Promise.reject(fail(new Error("EMPTY_NAME")));

    return getHierarchy(featureId).then(function (h) {
      var school = h.schools.filter(function (s) { return s.id === schoolId; })[0];
      if (!school) return Promise.reject(fail(new Error("NO_SCHOOL")));

      var low = cname.toLowerCase();
      var dup = school.classes.filter(function (c) {
        return String(c.name).toLowerCase() === low;
      })[0];
      if (dup) return Promise.resolve(dup);

      var maxOrder = 0;
      school.classes.forEach(function (c) {
        maxOrder = Math.max(maxOrder, c.order || 0);
      });

      var cls = { id: hierId("cls_"), name: cname, order: maxOrder + 1 };
      school.classes.push(cls);
      return saveHierarchy(featureId, h).then(function () { return cls; });
    });
  }

  /** renameSchool / renameClass — QUOTA: 1 write mỗi lần. */
  function renameSchool(featureId, schoolId, name) {
    var n = String(name || "").trim().slice(0, 60);
    if (!n) return Promise.reject(fail(new Error("EMPTY_NAME")));
    return getHierarchy(featureId).then(function (h) {
      var s = h.schools.filter(function (x) { return x.id === schoolId; })[0];
      if (!s) return Promise.reject(fail(new Error("NO_SCHOOL")));
      s.name = n;
      return saveHierarchy(featureId, h).then(function () { return s; });
    });
  }

  function renameClass(featureId, schoolId, classId, name) {
    var n = String(name || "").trim().slice(0, 60);
    if (!n) return Promise.reject(fail(new Error("EMPTY_NAME")));
    return getHierarchy(featureId).then(function (h) {
      var s = h.schools.filter(function (x) { return x.id === schoolId; })[0];
      if (!s) return Promise.reject(fail(new Error("NO_SCHOOL")));
      var c = s.classes.filter(function (x) { return x.id === classId; })[0];
      if (!c) return Promise.reject(fail(new Error("NO_CLASS")));
      c.name = n;
      return saveHierarchy(featureId, h).then(function () { return c; });
    });
  }

  /**
   * renameClassEverywhere(featureId, schoolId, classId, name, onProgress)
   *   → Promise<{class, groups, chunks, oldName}>
   *
   * Đổi tên lớp và ĐỒNG BỘ luôn `className` của MỌI nhóm thuộc lớp đó.
   *
   * VÌ SAO PHẢI ĐỒNG BỘ HAI NƠI?
   *   `className` được denormalize vào từng document nhóm để lọc theo lớp với
   *   0 read. Nếu chỉ đổi tên trong meta/hierarchy thì danh mục hiện tên mới
   *   nhưng nhóm vẫn giữ tên cũ → hai nguồn sự thật lệch nhau, và lần sau
   *   `reconcileHierarchy` có thể dựng lại một lớp trùng tên cũ.
   *
   * QUOTA (N = số nhóm trong lớp):
   *   • 1 read  — getHierarchy (đã có cache thì vẫn 1 read, không đọc từng nhóm)
   *   • 1 write — meta/hierarchy (PATCH có updateMask, ~0,3 KB)
   *   • N write — mỗi nhóm 1 PATCH chỉ gồm `className` + `updatedAt` (~60 byte),
   *               gộp vào `:commit`, tối đa MAX_WRITES_PER_COMMIT (400) write/lần.
   *   Với 6 nhóm: 1 + 6 = 7 writes, ~0,7 KB egress. Đây là thao tác HIẾM
   *   (đầu năm học), không nằm trên đường nóng như cộng star.
   *
   * VÌ SAO KHÔNG DÙNG syncGroup CHO TỪNG NHÓM?
   *   syncGroup gửi N request HTTP riêng lẻ. `:commit` gộp N write vào 1 request
   *   → ít round-trip hơn, và vẫn tính đúng N document write (không thể rẻ hơn:
   *   Firestore tính tiền theo document, không theo request).
   *
   * AN TOÀN: nếu một chunk lỗi, hierarchy đã đổi tên nhưng một số nhóm chưa.
   *   Caller nhận lỗi và hoàn tác UI; gọi lại hàm này sẽ ghi tiếp phần còn lại
   *   (idempotent — ghi cùng một giá trị `className` nhiều lần không sai).
   */
  function renameClassEverywhere(featureId, schoolId, classId, name, onProgress) {
    quotaSetOp("class-rename");
    var n = String(name || "").trim().slice(0, 60);
    if (!n) return Promise.reject(fail(new Error("EMPTY_NAME")));

    return getHierarchy(featureId).then(function (h) {
      var s = h.schools.filter(function (x) { return x.id === schoolId; })[0];
      if (!s) return Promise.reject(fail(new Error("NO_SCHOOL")));
      var c = s.classes.filter(function (x) { return x.id === classId; })[0];
      if (!c) return Promise.reject(fail(new Error("NO_CLASS")));

      var oldName = c.name;
      c.name = n;

      // Nhóm thuộc lớp này — 0 read, lọc trên cache đã tải.
      var inClass = (state.groups[featureId] || []).filter(function (g) {
        return classIdOf(g) === classId;
      });

      // Cập nhật cache cục bộ ngay để UI/lần đọc sau thấy tên mới.
      inClass.forEach(function (g) { g.className = n; });

      if (state.backend === "local") {
        localSaveHierarchy(featureId, h);
        // ⚠️ CHỈ gọi localSave khi db.js THỰC SỰ đang giữ danh sách nhóm.
        // Ở chế độ local, trang tự lưu UI state riêng (khoá "star-race-v1");
        // state.groups[featureId] có thể chưa được nạp → localSave sẽ ghi []
        // và XOÁ MẤT nhóm trong localStorage. Đây là lỗi thật đã gặp khi test.
        if (state.groups[featureId]) localSave(featureId);
        emitMeta(featureId);
        emit(featureId);
        return { "class": c, groups: inClass.length, chunks: 0, oldName: oldName };
      }

      // ---- 1) Danh mục: 1 write ----
      return saveHierarchy(featureId, h).then(function () {
        if (!inClass.length) {
          emit(featureId);
          return { "class": c, groups: 0, chunks: 0, oldName: oldName };
        }

        // ---- 2) Từng nhóm: 1 write/nhóm, gộp vào :commit ----
        // Chỉ gửi `className` + `updatedAt` (updateMask) → payload ~60 byte/nhóm,
        // KHÔNG ghi lại students/stars/total (tránh ghi đè star của máy khác).
        var stamp = nowIso();
        var writes = inClass.map(function (g) {
          return {
            update: {
              name: fullName(groupPath(featureId, g.id)),
              fields: {
                className: { stringValue: n },
                updatedAt: { timestampValue: stamp }
              }
            },
            updateMask: { fieldPaths: ["className", "updatedAt"] }
          };
        });

        var chunks = [];
        for (var i = 0; i < writes.length; i += MAX_WRITES_PER_COMMIT) {
          chunks.push(writes.slice(i, i + MAX_WRITES_PER_COMMIT));
        }

        var commitUrl = docRoot() + ":commit";
        var done = 0;
        var chain = Promise.resolve();

        chunks.forEach(function (chunk, ci) {
          chain = chain.then(function () {
            return call("POST", commitUrl, { writes: chunk }).then(function () {
              done += chunk.length;
              if (typeof onProgress === "function") {
                try {
                  onProgress({ done: done, total: writes.length,
                               chunk: ci + 1, chunks: chunks.length });
                } catch (e) { /* callback lỗi không được làm hỏng việc ghi */ }
              }
            });
          });
        });

        return chain.then(function () {
          emit(featureId);
          return { "class": c, groups: writes.length, chunks: chunks.length, oldName: oldName };
        });
      });
    });
  }

  /**
   * deleteClass(featureId, schoolId, classId, moveGroups) — QUOTA: 1 write (meta) + N write
   * cho N nhóm phải chuyển sang lớp khác. Caller truyền moveGroups=true để chuyển nhóm;
   * nếu false thì từ chối xoá lớp còn nhóm (an toàn).
   *
   * KHÔNG còn “lớp mặc định” để hứng nhóm: nhóm được chuyển sang LỚP CÒN LẠI ĐẦU TIÊN
   * của cùng trường. Nếu đó là lớp CUỐI CÙNG của trường thì từ chối — xoá nó sẽ khiến
   * nhóm không còn chỗ nào để hiện (dùng deleteClassDeep nếu thực sự muốn xoá cả nhóm).
   */
  function deleteClass(featureId, schoolId, classId, moveGroups) {
    return getHierarchy(featureId).then(function (h) {
      var s = h.schools.filter(function (x) { return x.id === schoolId; })[0];
      if (!s) return Promise.reject(fail(new Error("NO_SCHOOL")));

      var inClass = (state.groups[featureId] || []).filter(function (g) {
        return classIdOf(g) === classId;
      });
      if (inClass.length && !moveGroups) {
        return Promise.reject(fail(new Error("CLASS_NOT_EMPTY")));
      }

      var rest = s.classes.filter(function (c) { return c.id !== classId; });

      // Lớp cuối cùng của trường còn giữ nhóm → không thể chuyển đi đâu được.
      if (inClass.length && !rest.length) {
        return Promise.reject(fail(new Error("LAST_CLASS")));
      }

      var dest = rest[0];
      var jobs = dest ? inClass.map(function (g) {
        return syncGroup(featureId, g.id, {
          schoolId: s.id, schoolName: s.name,
          classId: dest.id, className: dest.name
        });
      }) : [];

      return Promise.all(jobs).then(function () {
        s.classes = rest;
        return saveHierarchy(featureId, h);
      });
    });
  }

  /**
   * deleteClassDeep(featureId, schoolId, classId, onProgress)
   *   → Promise<{class, groups, writes, chunks}>
   *
   * XOÁ LỚP THẬT — khác deleteClass() ở trên (hàm đó chỉ CHUYỂN nhóm về lớp mặc
   * định rồi bỏ lớp khỏi danh mục, dữ liệu học sinh/điểm vẫn còn).
   * Hàm này xoá hẳn: document nhóm của mọi nhóm thuộc lớp (kèm students[], stars{},
   * total, cấu hình nhóm) + bỏ lớp khỏi meta/hierarchy. Lớp khác KHÔNG bị đụng.
   *
   * QUOTA (N = số nhóm của lớp):
   *   • N read   — 1 truy vấn lấy đúng N nhóm của lớp (lọc `classId ==`)
   *   • N write  — xoá N document nhóm, gộp vào `:commit` theo lô ≤ 400
   *   • 1 write  — meta/hierarchy (bỏ lớp khỏi danh mục)
   *   Với lớp 6 nhóm: 6 read + 7 write. Thao tác hiếm (dọn lớp đầu năm) nên
   *   chi phí này chấp nhận được; đổi lại không còn nhóm mồ côi.
   *
   * VÌ SAO TRUY VẤN MÀ KHÔNG LỌC TRÊN CACHE `state.groups`?
   *   Cache có thể thiếu nhóm vừa được tạo trên máy khác. Xoá theo cache sẽ bỏ sót
   *   → nhóm mồ côi vẫn nằm trên Firestore nhưng UI không hiển thị (vì lọc theo
   *   classId đã biến mất). Một truy vấn lấy đúng tập hiện tại trên server.
   *
   * AN TOÀN:
   *   • Chia lô MAX_WRITES_PER_COMMIT (400) → không bao giờ vượt 500 writes/commit.
   *   • Chỉ bỏ lớp khỏi danh mục SAU KHI xoá xong các nhóm → lỗi giữa đường thì
   *     lớp vẫn còn trong danh mục và gọi lại sẽ xoá tiếp phần còn lại (idempotent).
   */
  function deleteClassDeep(featureId, schoolId, classId, onProgress) {
    quotaSetOp("class-delete");

    return getHierarchy(featureId).then(function (h) {
      var s = h.schools.filter(function (x) { return x.id === schoolId; })[0];
      if (!s) return Promise.reject(fail(new Error("NO_SCHOOL")));
      var c = s.classes.filter(function (x) { return x.id === classId; })[0];
      if (!c) return Promise.reject(fail(new Error("NO_CLASS")));

      function finish(ids) {
        ids.forEach(function (gid) { removeLocal(featureId, gid); });
        // Chỉ tới đây mới bỏ lớp khỏi danh mục.
        s.classes = s.classes.filter(function (x) { return x.id !== classId; });
        return saveHierarchy(featureId, h).then(function () {
          emit(featureId);
          return {
            "class": c,
            groups: ids.length,
            writes: ids.length + 1,
            chunks: 0
          };
        });
      }

      if (state.backend === "local") {
        var localIds = (state.groups[featureId] || []).filter(function (g) {
          return classIdOf(g) === classId;
        }).map(function (g) { return g.id; });
        // saveHierarchy() bên trong finish() đã tự động ghi local khi backend="local",
        // nên KHÔNG gọi localSaveHierarchy ở đây (tránh ghi 2 lần).
        return finish(localIds);
      }

      var url = docRoot() + "/" + featurePath(featureId) + ":runQuery";
      var q = {
        structuredQuery: {
          from: [{ collectionId: "groups" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "classId" },
              op: "EQUAL",
              value: { stringValue: classId }
            }
          }
        }
      };

      return call("POST", url, q).then(function (rows) {
        var ids = [];
        (rows || []).forEach(function (row) {
          if (row && row.document && row.document.name) {
            ids.push(row.document.name.split("/").pop());
          }
        });

        var writes = ids.map(function (gid) {
          return { "delete": fullName(groupPath(featureId, gid)) };
        });

        var chunks = [];
        for (var i = 0; i < writes.length; i += MAX_WRITES_PER_COMMIT) {
          chunks.push(writes.slice(i, i + MAX_WRITES_PER_COMMIT));
        }

        var commitUrl = docRoot() + ":commit";
        var done = 0;
        var chain = Promise.resolve();

        chunks.forEach(function (chunk, ci) {
          chain = chain.then(function () {
            return call("POST", commitUrl, { writes: chunk }).then(function () {
              done += chunk.length;
              if (typeof onProgress === "function") {
                try {
                  onProgress({ done: done, total: writes.length,
                               chunk: ci + 1, chunks: chunks.length });
                } catch (e) { /* callback lỗi không làm hỏng việc xoá */ }
              }
            });
          });
        });

        return chain.then(function () {
          return finish(ids).then(function (res) {
            res.chunks = chunks.length;
            return res;
          });
        });
      });
    });
  }

  /**
   * deleteSchool(featureId, schoolId, moveGroups) — QUOTA: 1 write + N (chuyển nhóm)
   * Xoá trường = bỏ trường + toàn bộ lớp của nó khỏi danh mục; nhóm bên trong được
   * chuyển sang TRƯỜNG CÒN LẠI ĐẦU TIÊN (lớp đầu tiên của trường đó) để không mồ côi.
   * Nếu đây là trường CUỐI CÙNG thì từ chối khi trường còn nhóm.
   */
  function deleteSchool(featureId, schoolId, moveGroups) {
    return getHierarchy(featureId).then(function (h) {
      var s = h.schools.filter(function (x) { return x.id === schoolId; })[0];
      if (!s) return Promise.reject(fail(new Error("NO_SCHOOL")));

      var inSchool = (state.groups[featureId] || []).filter(function (g) {
        return schoolIdOf(g) === schoolId;
      });
      if (inSchool.length && !moveGroups) {
        return Promise.reject(fail(new Error("SCHOOL_NOT_EMPTY")));
      }

      var rest = h.schools.filter(function (x) { return x.id !== schoolId; });
      var dest = null;
      for (var i = 0; i < rest.length; i++) {
        if (rest[i].classes && rest[i].classes.length) { dest = rest[i]; break; }
      }

      // Trường cuối cùng còn nhóm → không còn nơi nào để chuyển.
      if (inSchool.length && !dest) {
        return Promise.reject(fail(new Error("LAST_SCHOOL")));
      }

      var destCls = dest ? dest.classes[0] : null;
      var jobs = (inSchool.length && destCls) ? inSchool.map(function (g) {
        return syncGroup(featureId, g.id, {
          schoolId: dest.id, schoolName: dest.name,
          classId: destCls.id, className: destCls.name
        });
      }) : [];

      return Promise.all(jobs).then(function () {
        h.schools = rest;
        return saveHierarchy(featureId, h);
      });
    });
  }

  /* ---- Truy cập trường/lớp của một NHÓM (0 read — đọc từ cache) ----
     KHÔNG còn giá trị mặc định: nhóm chưa phân cấp trả về chuỗi rỗng, và UI
     gán nó vào trường thật (assignOrphans). Nhờ vậy không có “nhóm ảo” nào
     lọt vào một bucket vô hình. */

  function schoolIdOf(g) {
    return (g && g.schoolId) ? String(g.schoolId) : "";
  }
  function classIdOf(g) {
    return (g && g.classId) ? String(g.classId) : "";
  }
  function schoolNameOf(g) {
    return (g && g.schoolName) ? String(g.schoolName) : "";
  }
  function classNameOf(g) {
    return (g && g.className) ? String(g.className) : "";
  }

  /**
   * reconcileHierarchy(featureId) → Promise<{schools, recovered}>
   *
   * BÙ ĐẮP KHI META KHÔNG ĐẦY ĐỦ — tình huống rất thật:
   *   • rules chưa deploy → meta chỉ có trên MÁY TẠO RA NÓ (localStorage);
   *   • người dùng mở trên máy/trình duyệt khác (hoặc sau khi xoá cache).
   * Khi đó groups vẫn có `schoolId/classId/schoolName/className` (đã denormalize
   * trên Firestore), nhưng danh mục thì trống → nhóm "vô hình" vì UI lọc theo
   * classId chưa tồn tại.
   *
   * Hàm này SUY RA trường/lớp từ chính các nhóm đã tải (0 read thêm — dữ liệu
   * đã nằm trong bộ nhớ) rồi trả về khung đã bù. Caller quyết định có lưu hay
   * không. Nhờ vậy: mất danh mục KHÔNG làm mất dữ liệu.
   */
  function reconcileHierarchy(featureId, base) {
    var h = normalizeHierarchy(base || state.meta[featureId] || null);
    var list = state.groups[featureId] || [];
    if (!list.length) return { schools: h.schools, recovered: 0 };

    var schoolMap = Object.create(null);
    h.schools.forEach(function (s) {
      schoolMap[s.id] = s;
      s.classes.forEach(function (c) { schoolMap[s.id + "/" + c.id] = c; });
    });

    var recovered = 0;

    list.forEach(function (g) {
      var sid = schoolIdOf(g);
      var cid = classIdOf(g);
      // Nhóm chưa phân cấp không suy ra được trường/lớp nào — bỏ qua.
      if (!sid || !cid) return;

      var s = schoolMap[sid];
      if (!s) {
        s = { id: sid, name: schoolNameOf(g), order: 900, classes: [] };
        h.schools.push(s);
        schoolMap[sid] = s;
        recovered++;
      }

      var hasCls = s.classes.some(function (c) { return c.id === cid; });
      if (!hasCls) {
        s.classes.push({ id: cid, name: classNameOf(g), order: 900 });
        recovered++;
      }
    });

    if (!recovered) return { schools: h.schools, recovered: 0 };

    // Sắp xếp lại theo order. Không còn mục nào phải đẩy xuống cuối.
    h.schools.sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });
    h.schools.forEach(function (s) {
      s.classes.sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
    });

    state.meta[featureId] = h;
    warn("Đã khôi phục " + recovered + " mục trường/lớp từ dữ liệu nhóm.");
    return { schools: h.schools, recovered: recovered };
  }

  /**
   * getGroupsByClass(featureId, classId) → array<group>
   *
   * QUOTA: 0 read. Lọc ngay trên cache `state.groups` — đây chính là lý do
   * chọn phương án denormalized: chuyển lớp không tốn thêm truy vấn nào.
   */
  function getGroupsByClass(featureId, classId) {
    var want = classId || "";
    return (state.groups[featureId] || []).filter(function (g) {
      return classIdOf(g) === want;
    });
  }

  function getGroupsBySchool(featureId, schoolId) {
    var want = schoolId || "";
    return (state.groups[featureId] || []).filter(function (g) {
      return schoolIdOf(g) === want;
    });
  }

  /** Đếm số nhóm theo lớp (0 read) — dùng để hiện "6 nhóm" ở danh sách lớp. */
  function countByClass(featureId) {
    var map = Object.create(null);
    (state.groups[featureId] || []).forEach(function (g) {
      var k = classIdOf(g);
      map[k] = (map[k] || 0) + 1;
    });
    return map;
  }

  function emitMeta(featureId) {
    if (!state.metaSubscribers || !state.metaSubscribers.length) return;
    var h = state.meta[featureId] || emptyHierarchy();
    state.metaSubscribers.forEach(function (cb) {
      try { cb(h); } catch (e) { warn("meta subscriber lỗi"); }
    });
  }

  function onMetaChange(cb) {
    state.metaSubscribers = state.metaSubscribers || [];
    state.metaSubscribers.push(cb);
    return function () {
      state.metaSubscribers = state.metaSubscribers.filter(function (f) { return f !== cb; });
    };
  }

  /* ==========================================================================
   * 7. TẠO / XOÁ / ĐỔI TÊN NHÓM
   * ======================================================================== */

  /**
   * createGroup(featureId, name, order) → Promise<group>
   * QUOTA: 0 read + 1 write.
   */
  function createGroup(featureId, name, order, extra) {
    quotaSetOp("group-create");
    // Cho phép truyền sẵn id (dùng khi nhập lớp / tạo nhóm mẫu) để UI không phải
    // đổi id sau khi ghi — tránh render lại hai lần.
    var gid = (extra && typeof extra.id === "string" && /^[a-z0-9_]{3,40}$/.test(extra.id))
      ? extra.id
      : randId("g_");
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

    // `extra` cho phép tạo nhóm kèm sẵn học sinh / star / biểu tượng / màu trong
    // CÙNG MỘT write (dùng khi nhập cài đặt lớp). Chỉ nhận các field đã biết để
    // không ghi rác vào document.
    if (extra && typeof extra === "object") {
      ["students", "stars", "total", "emoji", "color",
       "schoolId", "schoolName", "classId", "className"].forEach(function (k) {
        if (extra[k] !== undefined) doc[k] = extra[k];
      });
      if (Array.isArray(doc.students) && doc.students.length > MAX_STUDENTS) {
        doc.students = doc.students.slice(0, MAX_STUDENTS);
      }
    }

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
    quotaSetOp("group-delete");
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
    quotaSetOp("group-rename");
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

  /**
   * syncGroup(featureId, groupId, patch) → Promise<void>
   *
   * Ghi ĐÈ có chọn lọc các field cấu trúc của một nhóm trong MỘT PATCH.
   * Dùng cho màn "Cài đặt nhóm & thành viên": ở đó giáo viên sửa tên nhóm,
   * biểu tượng, màu, thêm/xoá/đổi tên học sinh cùng lúc.
   *
   * QUOTA: 0 read + 1 write / nhóm. Với 6 nhóm = 6 writes cho một lần lưu cài đặt
   * — thao tác hiếm, không phải đường nóng (cộng star vẫn là 1 write gộp).
   *
   * ⚡ VIỆC 1 — CHỐNG MẤT DỮ LIỆU (quan trọng hơn cả quota):
   * `stars` và `total` là DẪN XUẤT của `students` + phép cộng trên server. Ghi
   * chúng trong PATCH cấu hình nghĩa là "lấy ảnh chụp trên máy NÀY đè lên server":
   *   • cô A đang bấm star trên iPad,
   *   • cùng lúc bấm "Lưu cài đặt" ở tab khác (hoặc máy khác),
   *   → điểm vừa cộng BIẾN MẤT, không thể khôi phục.
   *
   * Nên: khi nhóm ĐÃ tồn tại (_exists) thì TUYỆT ĐỐI không gửi `stars`/`total`
   * trong updateMask. Chỉ ghi chúng khi TẠO nhóm mới (createGroup), nơi không có
   * giá trị nào trên server để đè.
   *
   * Star chỉ được thay đổi qua `changeStar` → `increment` (nguyên tử, 0 read).
   *
   * HỌC SINH BỊ XOÁ: nếu mảng `students` mới THIẾU id so với cache thì field
   * `stars.<sid>` của em đó phải bị XOÁ (đưa vào updateMask mà không có trong
   * `fields`), và `total` phải trừ đi star cũ của em ấy (increment âm). Hai việc
   * này làm trong CÙNG một commit với PATCH để không bao giờ lệch sổ.
   */
  function syncGroup(featureId, groupId, patch) {
    quotaSetOp("group-save");
    // Field cấu hình được phép ghi đè. `stars`/`total` bị LOẠI khỏi danh sách này
    // — chúng chỉ đi qua createGroup (tạo mới) hoặc changeStar (increment).
    var KEYS = ["name", "order", "emoji", "color", "students",
                "schoolId", "schoolName", "classId", "className"];
    var fields = {};
    var masks  = [];

    KEYS.forEach(function (k) {
      if (!patch || patch[k] === undefined) return;
      fields[k] = enc(patch[k]);
      masks.push(k);
    });
    if (!masks.length) return Promise.resolve();

    var stamp = nowIso();
    fields.updatedAt = { timestampValue: stamp };
    masks.push("updatedAt");

    // ---- Phát hiện học sinh vừa bị xoá khỏi mảng `students` ----
    // So với cache để biết em nào mất tích. Chỉ áp dụng khi caller THỰC SỰ gửi
    // `students` (nếu không gửi thì không có gì bị xoá).
    var removedStars = 0;
    var removedIds = [];
    if (patch && Array.isArray(patch.students)) {
      var before = localFind(featureId, groupId);
      var keep = Object.create(null);
      patch.students.forEach(function (s) { if (s && s.id) keep[s.id] = true; });

      if (before && (before.students || []).length) {
        var oldStars = before.stars || {};
        (before.students || []).forEach(function (s) {
          if (!s || !s.id || keep[s.id]) return;
          removedIds.push(s.id);
          removedStars += Math.max(0, Number(oldStars[s.id] || 0));
        });
      }
    }

    // Mỗi học sinh bị xoá → thêm `stars.<sid>` vào updateMask nhưng KHÔNG có
    // trong `fields` ⇒ Firestore xoá hẳn field đó (không để rác trong map).
    removedIds.forEach(function (sid) { masks.push("stars." + sid); });

    if (state.backend === "local") {
      var g = localFind(featureId, groupId);
      if (g) {
        KEYS.forEach(function (k) { if (patch[k] !== undefined) g[k] = patch[k]; });
        removedIds.forEach(function (sid) {
          if (g.stars) delete g.stars[sid];
        });
        if (removedStars) g.total = Math.max(0, Number(g.total || 0) - removedStars);
        g.updatedAt = stamp;
        localSave(featureId);
      }
      emit(featureId);
      return Promise.resolve();
    }

    var url = docRoot() + "/" + groupPath(featureId, groupId) + "?" +
              masks.map(function (m) {
                return "updateMask.fieldPaths=" + encodeURIComponent(m);
              }).join("&");

    // Có học sinh bị xoá → cần thêm một phép `increment` âm cho `total` để sổ
    // khớp. Gói chung vào MỘT `:commit` cùng PATCH: 2 write/document nhưng
    // ATOMIC và không bao giờ để `total` lệch với tổng `stars`.
    var trimTotal = removedStars > 0
      ? [{
          transform: {
            document: fullName(groupPath(featureId, groupId)),
            fieldTransforms: [{
              fieldPath: "total",
              increment: { integerValue: String(-removedStars) }
            }]
          }
        }]
      : [];

    function applyLocal() {
      var lg = localFind(featureId, groupId);
      if (lg) {
        KEYS.forEach(function (k) { if (patch[k] !== undefined) lg[k] = patch[k]; });
        removedIds.forEach(function (sid) { if (lg.stars) delete lg.stars[sid]; });
        if (removedStars) lg.total = Math.max(0, Number(lg.total || 0) - removedStars);
        lg.updatedAt = stamp;
      }
      emit(featureId);
    }

    if (!trimTotal.length) {
      return call("PATCH", url, { fields: fields }).then(applyLocal);
    }

    return call("POST", docRoot() + ":commit", {
      writes: [{ update: { name: fullName(groupPath(featureId, groupId)),
                           fields: fields },
                 updateMask: { fieldPaths: masks } }].concat(trimTotal)
    }).then(applyLocal);
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
    quotaSetOp("student-add");
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
    quotaSetOp("student-remove");
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
    quotaSetOp("star");
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
      if (!Array.isArray(list)) list = [];
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
    quotaSetOp("poll");
    if (quota.on) quota.polls += 1;

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
      // ⚡ VIỆC 3: dữ liệu vừa về từ máy khác → cache cũng phải mới, tránh F5
      // trong 60 s đọc ra ảnh chụp cũ và làm thay đổi của máy kia biến mất.
      setGroupsCache(L.featureId, list);

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

  /* ---- Khung trường/lớp ở chế độ local ---- */
  function localAllMeta() {
    try { return JSON.parse(global.localStorage.getItem(LS_META) || "{}"); }
    catch (e) { return {}; }
  }

  function localGetHierarchy(featureId) {
    if (state.meta[featureId]) return state.meta[featureId];
    var all = localAllMeta();
    var h = normalizeHierarchy(all[localKey(featureId)] || null);
    state.meta[featureId] = h;
    return h;
  }

  function localSaveHierarchy(featureId, h) {
    try {
      var all = localAllMeta();
      all[localKey(featureId)] = h;
      global.localStorage.setItem(LS_META, JSON.stringify(all));
    } catch (e) { warn("localStorage đầy hoặc bị chặn"); }
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
    // ⚡ VIỆC 3: cache cũng phải thấy thay đổi này, nếu không lần F5 kế tiếp
    // sẽ đọc ra danh sách CŨ (60 s) và làm nhóm vừa tạo biến mất.
    setGroupsCache(featureId, list);
  }

  function removeLocal(featureId, groupId) {
    var list = state.groups[featureId] || [];
    var next = list.filter(function (g) { return g.id !== groupId; });
    setGroupsCache(featureId, next);
    // Chế độ Local: phải ghi xuống localStorage, nếu không F5 sẽ đọc lại nhóm đã xoá.
    if (state.backend === "local") localSave(featureId);
  }

  function emit(featureId) {
    var list = state.groups[featureId] || [];
    // ⚡ VIỆC 3: `emit` được gọi ở MỌI thay đổi cục bộ (star, tên, học sinh...).
    // Đây là điểm chốt để cache luôn khớp với UI: nếu bỏ qua, cache 60 s sẽ
    // trả về ảnh chụp CŨ sau khi F5 (mất star vừa cộng trên màn hình).
    setGroupsCache(featureId, list);
    state.subscribers.forEach(function (cb) {
      try { cb(list, { local: true }); } catch (e) { warn("subscriber lỗi"); }
    });
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
    state.meta = Object.create(null);
    state.metaAt = Object.create(null);
    state.groupsAt = Object.create(null);
    // ⚡ VIỆC 3: dọn cả cache sessionStorage khi đăng xuất.
    clearGroupsCache();
  }

  /* ==========================================================================
   * 14b. HỒ SƠ NGƯỜI DÙNG — users/{uid}
   * --------------------------------------------------------------------------
   * QUOTA: 1 read + 1 write mỗi lần ĐĂNG NHẬP (không phải mỗi lần mở trang).
   *   • Đã có hồ sơ → PATCH chỉ 2 field vận hành (updatedAt, lastLoginAt)
   *                   kèm updateMask ⇒ KHÔNG ghi đè username/createdAt/plan.
   *   • Chưa có     → PATCH tạo mới đủ field tối thiểu (tương đương setDoc
   *                   merge:true của SDK).
   * Dùng PATCH + updateMask thay vì PUT để không bao giờ xoá field lạ.
   * ========================================================================== */

  function ensureUserProfile(username) {
    var name = String(username || state.userName || "").trim();

    if (state.backend === "local") {
      return Promise.resolve({ backend: "local", created: false, uid: state.uid });
    }
    if (!name) return Promise.reject(fail(new Error("NO_USERNAME")));

    var now = nowIso();
    var url = docRoot() + "/" + userPath();

    // BƯỚC 1 — đọc hồ sơ (1 read).
    return call("GET", url).then(function () {
      // BƯỚC 2a — đã có: chỉ chạm 2 field vận hành.
      var mask = "updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=lastLoginAt";
      var body = {
        fields: {
          updatedAt:   { timestampValue: now },
          lastLoginAt: { timestampValue: now }
        }
      };
      return call("PATCH", url + "?" + mask, body).then(function () {
        return { backend: "firestore", created: false, uid: state.uid };
      });
    }).catch(function (err) {
      var c = (err && (err.code || err.message)) || "";
      if (c !== "NOT_FOUND" && c !== "HTTP_404") throw err;

      // BƯỚC 2b — chưa có: tạo mới (1 write).
      var fields = {
        username:      { stringValue: name },
        createdAt:     { timestampValue: now },
        updatedAt:     { timestampValue: now },
        lastLoginAt:   { timestampValue: now },
        plan:          { stringValue: "free" },
        schemaVersion: { integerValue: "1" }
      };
      var m = Object.keys(fields).map(function (k) {
        return "updateMask.fieldPaths=" + k;
      }).join("&");

      return call("PATCH", url + "?" + m, { fields: fields }).then(function () {
        return { backend: "firestore", created: true, uid: state.uid };
      });
    });
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

    // hồ sơ users/{uid} — gọi ngay sau khi đăng ký/đăng nhập thành công
    ensureUserProfile: ensureUserProfile,

    // đọc
    getGroups: getGroups,
    getGroup: getGroup,
    classTotal: classTotal,

    // phân cấp Trường → Lớp (1 read + 1 write)
    ensureFeatureParent: ensureFeatureParent,
    getHierarchy: getHierarchy,
    saveHierarchy: saveHierarchy,
    createSchool: createSchool,
    createClass: createClass,
    renameSchool: renameSchool,
    renameClass: renameClass,
    renameClassEverywhere: renameClassEverywhere,
    deleteSchool: deleteSchool,
    deleteClass: deleteClass,
    deleteClassDeep: deleteClassDeep,
    getGroupsByClass: getGroupsByClass,
    getGroupsBySchool: getGroupsBySchool,
    reconcileHierarchy: reconcileHierarchy,
    countByClass: countByClass,
    onMetaChange: onMetaChange,
    schoolIdOf: schoolIdOf,
    classIdOf: classIdOf,
    schoolNameOf: schoolNameOf,
    classNameOf: classNameOf,

    // nhóm
    createGroup: createGroup,
    deleteGroup: deleteGroup,
    renameGroup: renameGroup,
    syncGroup: syncGroup,

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

    // cache (⚡ VIỆC 3)
    clearGroupsCache: clearGroupsCache,

    // bộ đếm quota (TẮT mặc định — bật bằng ?debug=quota hoặc localStorage.tt_quota=1)
    quota: {
      enabled: function () { return quota.on; },
      snapshot: quotaSnapshot,
      reset: function () { quotaReset(); quotaRender(); },
      setOp: quotaSetOp
    },

    // cho test
    _state: state,
    _randId: randId,
    _enc: enc,
    _dec: dec,
    _COALESCE_MS: COALESCE_MS,
    _POLL_FAST_MS: POLL_FAST_MS,
    _POLL_SLOW_MS: POLL_SLOW_MS,
    _GROUPS_CACHE_TTL_MS: GROUPS_CACHE_TTL_MS,
    _HIER_CACHE_TTL_MS: HIER_CACHE_TTL_MS
  };

  global.TTDB = TTDB;

  // Tự gắn vòng đời trang ngay khi nạp script.
  bindLifecycle();

})(typeof window !== "undefined" ? window : this);
