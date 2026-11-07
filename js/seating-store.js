/**
 * TeachTool — Seating store (bàn / tổ / học sinh)
 * ---------------------------------------------------------------------------
 * VÌ SAO CÓ FILE NÀY
 *   js/db.js đã có getSeating/saveSeating/deleteSeating, nhưng `normSlots()`
 *   chỉ giữ {id, name, order, students[{id,name,gender}]} — nó CẮT MẤT các
 *   field cần cho sơ đồ phòng học: loại bàn (1–4 ghế), vị trí kéo thả (x, y),
 *   dãy/tổ (groupId) và ghế của từng em (seat).
 *
 *   Thay vì sửa js/db.js (file lõi dùng chung cho cả app), module này ghi vào
 *   ĐÚNG CÙNG MỘT document + CÙNG MỘT field như db.js:
 *
 *     users/{uid}/features/class-manager/meta/hierarchy   field: seating
 *
 *   nên dữ liệu vẫn là một nguồn duy nhất, star-race/Chấm điểm nhóm không bị
 *   ảnh hưởng, firestore.rules không phải sửa một dòng nào.
 *
 * Dùng: nạp SAU /js/db.js. Module tự gắn vào TTDB (TTDB.saveSeating, ...).
 * ---------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  var TTDB = global.TTDB;
  if (!TTDB || !TTDB._state) return;

  var FEATURE_ID = "class-manager";
  var META_ID    = "hierarchy";     // rules chỉ mở meta khi metaId === 'hierarchy'
  var MAX_CLASSES  = 30;
  var MAX_TABLES   = 60;
  var MAX_STUDENTS = 200;

  /* ---------------- Firestore REST: typed values ---------------- */
  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") {
      return (Number.isInteger(v) && Math.abs(v) < 1e15)
        ? { integerValue: String(v) }
        : { doubleValue: v };
    }
    if (typeof v === "string") return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    var f = {};
    Object.keys(v).forEach(function (k) { f[k] = enc(v[k]); });
    return { mapValue: { fields: f } };
  }
  function dec(v) {
    if (!v || typeof v !== "object") return null;
    if ("nullValue" in v) return null;
    if ("booleanValue" in v) return v.booleanValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("stringValue" in v) return v.stringValue;
    if ("timestampValue" in v) return v.timestampValue;
    if (v.arrayValue) return (v.arrayValue.values || []).map(dec);
    if (v.mapValue) {
      var out = {}, f = v.mapValue.fields || {};
      Object.keys(f).forEach(function (k) { out[k] = dec(f[k]); });
      return out;
    }
    return null;
  }

  function docUrl() {
    var s = TTDB._state;
    return "https://firestore.googleapis.com/v1/projects/" + s.projectId +
           "/databases/(default)/documents/users/" + s.uid +
           "/features/" + FEATURE_ID + "/meta/" + META_ID;
  }
  function localKey() { return "tt_seating_v1:" + FEATURE_ID; }

  function request(method, url, body) {
    var s = TTDB._state;
    var opt = {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (s.token || "")
      }
    };
    if (body) opt.body = JSON.stringify(body);
    return fetch(url, opt).then(function (r) {
      return r.text().then(function (txt) {
        if (r.ok) return txt ? JSON.parse(txt) : {};
        var msg = txt;
        try { msg = (JSON.parse(txt).error || {}).message || txt; } catch (e) { /* raw */ }
        var err = new Error(msg);
        err.code = "HTTP_" + r.status;
        err.status = r.status;
        throw err;
      });
    });
  }

  /* ---------------- Chuẩn hoá (GIỮ đủ field phòng học) ---------------- */
  function normStudent(st) {
    if (!st || typeof st !== "object" || !st.id) return null;
    var o = {
      id: String(st.id),
      name: String(st.name || "Học sinh").slice(0, 40),
      gender: (st.gender === "nu" || st.gender === "nữ") ? "nu" : "nam"
    };
    if (typeof st.seat === "number" && st.seat >= 1 && st.seat <= 4) o.seat = st.seat;
    return o;
  }
  function normTable(t, i) {
    if (!t || typeof t !== "object" || !t.id) return null;
    var students = [];
    (Array.isArray(t.students) ? t.students : []).forEach(function (st) {
      if (students.length >= MAX_STUDENTS) return;
      var n = normStudent(st);
      if (n) students.push(n);
    });
    var o = {
      id: String(t.id),
      name: String(t.name || "Bàn").slice(0, 40),
      order: typeof t.order === "number" ? t.order : (i + 1),
      type: (typeof t.type === "number" && t.type >= 1 && t.type <= 4) ? t.type : 2,
      x: (typeof t.x === "number" && isFinite(t.x)) ? Math.round(t.x) : 20,
      y: (typeof t.y === "number" && isFinite(t.y)) ? Math.round(t.y) : 60,
      students: students
    };
    if (typeof t.groupId === "string" && t.groupId) o.groupId = t.groupId;
    return o;
  }
  function normGroup(g, i) {
    if (!g || typeof g !== "object" || !g.id) return null;
    var students = [];
    (Array.isArray(g.students) ? g.students : []).forEach(function (st) {
      if (students.length >= MAX_STUDENTS) return;
      var n = normStudent(st);
      if (n) students.push(n);
    });
    return {
      id: String(g.id),
      name: String(g.name || "Tổ").slice(0, 40),
      order: typeof g.order === "number" ? g.order : (i + 1),
      students: students
    };
  }
  function normClasses(raw) {
    var out = {};
    var keys = Object.keys(raw || {}).slice(0, MAX_CLASSES);
    keys.forEach(function (cid) {
      var c = raw[cid] || {};
      var tables = [];
      (Array.isArray(c.tables) ? c.tables : []).forEach(function (t, i) {
        if (tables.length >= MAX_TABLES) return;
        var n = normTable(t, i);
        if (n) tables.push(n);
      });
      var groups = [];
      (Array.isArray(c.groups) ? c.groups : []).forEach(function (g, i) {
        if (groups.length >= MAX_TABLES) return;
        var n = normGroup(g, i);
        if (n) groups.push(n);
      });
      out[cid] = { tables: tables, groups: groups };
    });
    return out;
  }

  function localGet() {
    try {
      var raw = global.localStorage.getItem(localKey());
      if (!raw) return { classes: {}, updatedAt: null };
      var d = JSON.parse(raw);
      return { classes: normClasses(d && d.classes), updatedAt: (d && d.updatedAt) || null };
    } catch (e) { return { classes: {}, updatedAt: null }; }
  }
  function localSave(d) {
    try { global.localStorage.setItem(localKey(), JSON.stringify(d)); } catch (e) {}
  }

  /* ---------------- API ---------------- */
  function getSeating() {
    if (TTDB._state.backend === "local") return Promise.resolve(localGet());
    return request("GET", docUrl())
      .then(function (doc) {
        var seating = doc && doc.fields && dec(doc.fields.seating);
        return { classes: normClasses(seating), updatedAt: null };
      })
      .catch(function (e) {
        if (e.status === 404) return { classes: {}, updatedAt: null };
        return localGet();
      });
  }

  function saveSeating(_featureId, data) {
    var classes = normClasses(data && data.classes);
    var clean = { classes: classes, updatedAt: new Date().toISOString() };

    if (TTDB._state.backend === "local") {
      localSave(clean);
      return Promise.resolve(clean);
    }
    var url = docUrl() +
      "?updateMask.fieldPaths=schools&updateMask.fieldPaths=seating&updateMask.fieldPaths=updatedAt";
    var body = {
      fields: {
        // `schools` là field BẮT BUỘC của rules cho meta/hierarchy (has('schools')).
        // Danh mục trường/lớp thật nằm ở meta/hierarchy của star-race, không ở đây.
        schools: enc([]),
        seating: enc(classes),
        updatedAt: { timestampValue: clean.updatedAt }
      }
    };
    return request("PATCH", url, body)
      .then(function () { return clean; })
      .catch(function (e) {
        if (e.code === "HTTP_403") {
          localSave(clean);
          return clean;
        }
        throw e;
      });
  }

  function deleteSeating(_featureId, classId) {
    if (TTDB._state.backend === "local") {
      var d = localGet();
      if (classId && d.classes) delete d.classes[classId];
      else d = { classes: {}, updatedAt: null };
      localSave(d);
      return Promise.resolve();
    }
    if (!classId) {
      return request("DELETE", docUrl()).catch(function () {});
    }
    return getSeating().then(function (d) {
      if (d.classes && d.classes[classId]) delete d.classes[classId];
      return saveSeating(FEATURE_ID, d);
    });
  }

  /* Gắn đè lên bản trong db.js — cùng document, nhưng giữ đủ field phòng học. */
  TTDB.getSeating    = getSeating;
  TTDB.saveSeating   = saveSeating;
  TTDB.deleteSeating = deleteSeating;
  TTDB.__seatingStore = "phong-hoc-v1";

})(typeof window !== "undefined" ? window : this);
