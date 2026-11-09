
(function(){
  "use strict";

  /* ============================================================
     HẰNG SỐ
     FEATURE_ID = "star-race"  ← CỐ Ý dùng chung với Chấm điểm nhóm:
     trường/lớp nằm ở CÙNG meta/hierarchy, giáo viên thấy đúng một
     danh mục lớp ở cả hai tính năng. Dữ liệu bàn/tổ/học sinh nằm
     ở feature riêng "class-manager" (xem js/db.js mục 14c).
     ============================================================ */
  var FEATURE_ID = "star-race";
  var LS_SEL     = "class-manager-v1-sel";
  var SAVE_DEBOUNCE_MS = 900;

  /* GÓC NHÌN PHÒNG HỌC — lưu localStorage, không ghi Firestore (0 read / 0 write)
     v0 Dưới lên (mặc định) · v2 Trên xuống · v1 Trái nhìn sang · v3 Phải nhìn sang */
  var LS_ROT = "class-manager-v1-rot";
  var V_ORDER = ["0", "1", "2", "3"];
  var V_LABEL = { "0": "Dưới lên", "1": "Trái nhìn sang", "2": "Trên xuống", "3": "Phải nhìn sang" };
  var vrot = "0";
  function loadRot(){
    try{ var r = localStorage.getItem(LS_ROT); if (r && V_LABEL[r]) vrot = r; }catch(e){}
  }
  function saveRot(){
    try{ localStorage.setItem(LS_ROT, vrot); }catch(e){}
  }
  function setRotation(v, save){
    vrot = V_LABEL[v] ? v : "0";
    var rmv = $("#rmv");
    if (rmv) rmv.setAttribute("data-v", vrot);
    var lbl = $("#vLabel");
    if (lbl) lbl.textContent = "Góc nhìn: " + V_LABEL[vrot];
    if (save !== false) saveRot();
  }

  var SCHOOL_ICONS = ["🏫","🏢","🏛","🎓","🏫","🌳","🏠"];
  var CLASS_ICONS  = ["📚","✏","🎒","🧩","🎨","🔬","🌟"];

  /* ============================================================
     TRẠNG THÁI
     ============================================================ */
  var hier = { schools: [], updatedAt: null };
  var seating = { classes: {}, updatedAt: null };
  var selSchoolId = null;
  var selClassId  = null;
  var level = "schools";        // "schools" | "classes" | "room"
  var sel = null;               // học sinh đang chọn để chuyển { tableId, seat }
  var busy = false;
  var saveTimer = null;
  var savingCount = 0;

  /* ============================================================
     TIỆN ÍCH
     ============================================================ */
  function $(s, r){ return (r||document).querySelector(s); }
  function $$(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); }
  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function uid(prefix){
    var s = "", abc = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (var i=0;i<10;i++) s += abc.charAt(Math.floor(Math.random()*abc.length));
    return (prefix||"") + s;
  }
  var toastTimer = null;
  function toast(msg){
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("on");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove("on"); }, 2200);
  }
  function showSaving(on){
    savingCount += on ? 1 : -1;
    if (savingCount < 0) savingCount = 0;
    $("#saving").classList.toggle("on", savingCount > 0);
  }

  /* ============================================================
     NHỚ LỰA CHỌN
     ============================================================ */
  function loadSel(){
    try{
      var raw = localStorage.getItem(LS_SEL);
      if (raw){
        var s = JSON.parse(raw);
        if (s){
          if (typeof s.schoolId === "string") selSchoolId = s.schoolId;
          if (typeof s.classId  === "string") selClassId  = s.classId;
          if (s.level === "classes" || s.level === "room") level = s.level;
        }
      }
    }catch(e){}
  }
  function saveSel(){
    try{
      localStorage.setItem(LS_SEL, JSON.stringify({
        schoolId: selSchoolId, classId: selClassId, level: level
      }));
    }catch(e){}
  }

  function findSchool(sid){
    for (var i=0;i<hier.schools.length;i++) if (hier.schools[i].id === sid) return hier.schools[i];
    return null;
  }
  function curSchool(){ return selSchoolId ? findSchool(selSchoolId) : null; }
  function curClass(){
    var s = curSchool();
    if (!s || !selClassId) return null;
    for (var i=0;i<s.classes.length;i++) if (s.classes[i].id === selClassId) return s.classes[i];
    return null;
  }

  /* ============================================================
     DỮ LIỆU PHÒNG HỌC CỦA LỚP ĐANG CHỌN
     tables: [{id,name,type(1-4),x,y,groupId,students:[{id,name,gender,seat}]}]
     groups: [{id,name,order}]  — các dãy/tổ
     ============================================================ */
  function curData(){
    if (!selClassId) return { tables: [], groups: [] };
    if (!seating.classes) seating.classes = {};
    if (!seating.classes[selClassId]) seating.classes[selClassId] = { tables: [], groups: [] };
    var d = seating.classes[selClassId];
    if (!Array.isArray(d.tables)) d.tables = [];
    if (!Array.isArray(d.groups)) d.groups = [];
    return d;
  }
  function findTable(id){
    var list = curData().tables;
    for (var i=0;i<list.length;i++) if (list[i].id === id) return list[i];
    return null;
  }
  function findGroup(id){
    var list = curData().groups;
    for (var i=0;i<list.length;i++) if (list[i].id === id) return list[i];
    return null;
  }
  function countStudents(){
    var d = curData(), nam = 0, nu = 0;
    d.tables.forEach(function(t){
      t.students.forEach(function(st){ if (st.gender === "nu") nu++; else nam++; });
    });
    return { nam: nam, nu: nu, total: nam + nu };
  }

  /* ============================================================
     LƯU (gộp 900 ms → 1 write)
     ============================================================ */
  var saveSeq = 0;      // tăng mỗi lần có thay đổi — phát hiện sửa trong lúc đang lưu
  var saveChain = Promise.resolve();  // TUẦN TỰ HOÁ: không cho 2 request ghi chồng nhau
  function scheduleSave(){
    saveSeq++;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
  function flushSave(){
    if (saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
    if (!TTDB || typeof TTDB.saveSeating !== "function") return Promise.resolve();
    var mySeq = saveSeq;
    // Chụp ảnh state NGAY LÚC NÀY; nối vào chuỗi để request trước kết thúc rồi mới gửi.
    var snapshot = seating;
    showSaving(true);
    saveChain = saveChain.then(function(){
      return TTDB.saveSeating(FEATURE_ID, snapshot)
        // CHỈ đồng bộ lại state từ bản đã chuẩn hoá nếu KHÔNG có sửa đổi nào xảy ra
        // trong lúc request đang bay — nếu không sẽ nuốt mất thao tác mới hơn.
        .then(function(clean){ if (saveSeq === mySeq) seating = clean; })
        .catch(function(e){
          toast("Không lưu được lên máy chủ: " + ((e && (e.code || e.message)) || e));
        });
    });
    return saveChain.then(function(){ showSaving(false); });
  }

  /* ============================================================
     MODAL DÙNG CHUNG
     ============================================================ */
  var modalOn = false;
  function openModal(title, bodyHTML, footHTML, onMount){
    $("#mTitle").textContent = title;
    $("#mBody").innerHTML = bodyHTML;
    $("#mFoot").innerHTML = footHTML;
    $("#modal").classList.add("on");
    modalOn = true;
    if (onMount) onMount();
  }
  function closeModal(){
    $("#modal").classList.remove("on");
    modalOn = false;
    $("#mBody").innerHTML = "";
    $("#mFoot").innerHTML = "";
  }
  $("#mClose").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", function(e){ if (e.target === $("#modal")) closeModal(); });
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape" && modalOn) closeModal();
  });

  /* ============================================================
     RENDER: BREADCRUMB (giống hệt star-race)
     ============================================================ */
  function renderCrumbs(){
    var host = $("#crumbs");
    if (level === "schools"){ host.innerHTML = ""; host.style.display = "none"; return; }
    host.style.display = "flex";
    var s = curSchool(), c = curClass();
    var html = '<button class="crumb" type="button" data-crumb="schools">' +
               '<span class="ce">🏫</span><span class="ct">' +
               esc(s ? s.name : "Trường") +
               '</span></button>';
    if (level !== "schools"){
      html += '<span class="crumb-sep">›</span>' +
              '<button class="crumb' + (level === "classes" ? " on" : "") +
              '" type="button" data-crumb="classes">' +
              '<span class="ce">📚</span><span class="ct">' +
              esc(level === "classes" ? "Chọn lớp" : (c ? c.name : "Lớp")) +
              '</span></button>';
    }
    host.innerHTML = html;
  }

  /* ============================================================
     RENDER: MÀN CHỌN TRƯỜNG
     ============================================================ */
  function renderSchools(){
    $("#pickIco").textContent = "🏫";
    $("#pickTitleText").textContent = "Chọn trường";
    var html = "";
    if (!hier.schools.length){
      html += '<div class="hempty">📖 Chưa có trường nào. Bấm <b>“➕ Tạo trường mới”</b> bên dưới để bắt đầu — ' +
              'trường này sẽ hiện luôn ở tính năng <b>Chấm điểm nhóm</b>.</div>';
    }
    html += '<div class="hgrid">';
    hier.schools.forEach(function(s, i){
      html += '<button class="hcard has-del" type="button" data-school="' + esc(s.id) + '" style="--hc:#E8F4FF">' +
                '<span class="hdel" data-delschool="' + esc(s.id) + '" title="Xoá trường">✕</span>' +
                '<span class="hemo">' + SCHOOL_ICONS[i % SCHOOL_ICONS.length] + '</span>' +
                '<span class="hbody">' +
                  '<span class="hname">' + esc(s.name) + '</span>' +
                  '<span class="hsub">' + s.classes.length + ' lớp</span>' +
                '</span>' +
                '<span class="hgo">›</span>' +
              '</button>';
    });
    html += '<button class="hcard add" type="button" data-newschool="1">➕ Tạo trường mới</button>';
    html += '</div>';
    html += '<div class="hnew" id="newSchoolBox" style="display:none">' +
              '<input class="hinp" id="newSchoolName" type="text" maxlength="60" ' +
                     'placeholder="Tên trường, ví dụ: Tiểu học Kim Đồng" autocomplete="off">' +
              '<button class="hbtn mint" id="btnCreateSchool" type="button">✅ Tạo trường</button>' +
              '<button class="hbtn ghost" id="btnCancelSchool" type="button">Huỷ</button>' +
            '</div>';
    $("#pickBody").innerHTML = html;
  }

  /* ============================================================
     RENDER: MÀN CHỌN LỚP
     ============================================================ */
  function renderClasses(){
    var s = curSchool();
    if (!s){ level = "schools"; render(); return; }
    $("#pickIco").textContent = "📚";
    $("#pickTitleText").textContent = "Chọn lớp";
    var html = '<div class="hgrid">';
    s.classes.forEach(function(c, i){
      html += '<button class="hcard has-del" type="button" data-class="' + esc(c.id) + '" style="--hc:#FFF4DC">' +
                '<span class="hren" data-renclass="' + esc(c.id) + '" title="Đổi tên lớp">✏</span>' +
                '<span class="hdel" data-delclass="' + esc(c.id) + '" title="Xoá lớp">✕</span>' +
                '<span class="hemo">' + CLASS_ICONS[i % CLASS_ICONS.length] + '</span>' +
                '<span class="hbody">' +
                  '<span class="hname">' + esc(c.name) + '</span>' +
                  '<span class="hsub">' + esc(s.name) + '</span>' +
                '</span>' +
                '<span class="hgo">›</span>' +
              '</button>';
    });
    html += '<button class="hcard add" type="button" data-newclass="1">➕ Tạo lớp mới</button>';
    html += '</div>';
    html += '<div class="hnew" id="newClassBox" style="display:none">' +
              '<input class="hinp" id="newClassName" type="text" maxlength="60" ' +
                     'placeholder="Tên lớp, ví dụ: Lớp 3A" autocomplete="off">' +
              '<button class="hbtn mint" id="btnCreateClass" type="button">✅ Tạo lớp</button>' +
              '<button class="hbtn ghost" id="btnCancelClass" type="button">Huỷ</button>' +
            '</div>';
    $("#pickBody").innerHTML = html;
  }

  /* ============================================================
     RENDER: PHÒNG HỌC
     ============================================================ */
  function initialOf(name){
    var s = String(name || "").trim();
    if (!s) return "?";
    var parts = s.split(/\s+/);
    var last = parts[parts.length - 1] || s;
    return last.charAt(0).toUpperCase();
  }
  function seatHTML(t, st){
    var g = st.gender === "nu" ? "nu" : "nam";
    var label = g === "nu" ? "Nữ" : "Nam";
    var isSel = sel && sel.tableId === t.id && sel.seat === st.seat;
    return '<div class="seat filled ' + g + (isSel ? " sel" : "") + '" ' +
             'data-seat="' + st.seat + '" data-table="' + esc(t.id) + '" ' +
             'data-stu="' + esc(st.id) + '" title="' + esc(st.name) + ' — ' + label + '">' +
             '<span class="s-av" aria-hidden="true">' + esc(initialOf(st.name)) + '</span>' +
             '<span class="s-name">' + esc(st.name) + '</span>' +
             '<span class="s-x" data-delstu="' + esc(st.id) + '" data-table="' + esc(t.id) + '" data-seat="' + st.seat + '" title="Xoá học sinh">✕</span>' +
           '</div>';
  }
  function emptySeatHTML(t, seatIdx){
    return '<div class="seat empty" data-table="' + esc(t.id) + '" data-seat="' + seatIdx + '" title="Ghế trống — bấm để thêm học sinh">＋</div>';
  }
  function tableHTML(t){
    var type = t.type || 2;
    // MỘT hàng ngang duy nhất: ghế 1..type nằm cạnh nhau, không chia 2-2.
    // Mặt bàn (.t-top) có bảng tên + ký hiệu loại bàn; ghế là hình viên thuốc có avatar.
    var html = '<div class="table" data-table="' + esc(t.id) + '">' +
      '<div class="t-top">' +
        '<div class="t-bar">' +
          '<span class="t-name" title="' + esc(t.name) + '">' + esc(t.name) + '</span>' +
          '<span class="t-type">' + type + ' ghế</span>' +
        '</div>' +
        '<div class="t-seats">';
    for (var seatIdx=1; seatIdx<=type; seatIdx++){
      var st = null;
      for (var j=0;j<t.students.length;j++) if (t.students[j].seat === seatIdx) st = t.students[j];
      html += st ? seatHTML(t, st) : emptySeatHTML(t, seatIdx);
    }
    html += '</div>' +
      '</div>' +
      '<div class="t-acts">' +
        '<button type="button" data-ren-table="' + esc(t.id) + '" title="Đổi tên bàn">✏</button>' +
        '<button type="button" data-type-table="' + esc(t.id) + '" title="Đổi loại bàn">🔧</button>' +
        '<button type="button" class="tdel" data-del-table="' + esc(t.id) + '" title="Xoá bàn">✕</button>' +
      '</div>' +
    '</div>';
    return html;
  }
  function laneHTML(g, idx){
    var tables = curData().tables.filter(function(t){ return t.groupId === g.id; });
    // Bàn là CON của .lane-body (flex column) → tự xếp thẳng cột, nối tiếp cuối dãy.
    var body = "";
    tables.forEach(function(t){ body += tableHTML(t); });
    // Cuối dãy: CHỌN LOẠI BÀN TRỰC TIẾP — 4 nút 1/2/3/4 ghế, bấm 1 lần thêm bàn ngay.
    // Không mở hộp thoại xác nhận loại bàn nữa.
    var addBox = '<div class="lane-addbox">' +
      '<span class="lab-txt">➕ Thêm bàn</span>' +
      '<div class="lab-row">';
    for (var ti=1; ti<=4; ti++){
      var pips = "";
      for (var pj=0; pj<ti; pj++) pips += '<i></i>';
      addBox += '<button class="lab-btn" type="button" data-lane-add="' + esc(g.id) + '" data-add-type="' + ti + '" ' +
                'title="Thêm bàn ' + ti + ' ghế" aria-label="Thêm bàn ' + ti + ' ghế">' +
                '<span class="lb-g" aria-hidden="true">' + pips + '</span>' + ti + '</button>';
    }
    addBox += '</div></div>';
    return '<div class="lane" data-lane="' + esc(g.id) + '">' +
      '<div class="lane-head">' + esc(g.name) + ' <span class="lh-cnt">(' + tables.length + ' bàn)</span></div>' +
      '<div class="lane-body">' + body + '</div>' +
      addBox +
    '</div>';
  }

  function renderRoom(){
    var c = curClass();
    $("#editTitleText").textContent = c ? c.name : "Xếp chỗ";
    var d = curData();
    var room = $("#room");
    var empty = $("#roomEmpty");

    if (!d.groups.length){
      empty.classList.remove("hide");
      room.querySelectorAll(".lane,.table").forEach(function(el){ el.remove(); });
    } else {
      empty.classList.add("hide");
      // Bàn mồ côi (groupId trỏ tới tổ đã bị xoá) → gán về tổ đầu tiên để không biến mất.
      var gids = {};
      d.groups.forEach(function(g){ gids[g.id] = 1; });
      d.tables.forEach(function(t){ if (!t.groupId || !gids[t.groupId]) t.groupId = d.groups[0].id; });
      var html = "";
      d.groups.forEach(function(g, i){ html += laneHTML(g, i); });
      room.querySelectorAll(".lane").forEach(function(el){ el.remove(); });
      room.insertAdjacentHTML("beforeend", html);
    }

    var n = countStudents();
    $("#stat").innerHTML =
      '<span class="b">🗂 ' + d.groups.length + ' tổ</span>' +
      '<span class="b">🪑 ' + d.tables.length + ' bàn</span>' +
      '<span class="b">🎓 ' + n.total + ' học sinh</span>' +
      '<span class="b nam">♂ ' + n.nam + ' nam</span>' +
      '<span class="b nu">♀ ' + n.nu + ' nữ</span>';
  }

  /* ============================================================
     RENDER TỔNG
     ============================================================ */
  function render(){
    if (selSchoolId && !findSchool(selSchoolId)){ selSchoolId = null; selClassId = null; level = "schools"; }
    if (selClassId && !curClass()){ selClassId = null; if (level === "room") level = "classes"; }
    if (level === "classes" && !selSchoolId) level = "schools";
    if (level === "room" && !selClassId) level = selSchoolId ? "classes" : "schools";

    renderCrumbs();
    $("#btnBack").style.display = (level === "schools") ? "none" : "inline-flex";
    $("#navPanel").style.display = (level === "schools") ? "none" : "block";

    var pick = $("#pickPanel"), edit = $("#editPanel");
    if (level === "room"){
      pick.classList.add("hide");
      edit.classList.remove("hide");
      renderRoom();
    } else {
      edit.classList.add("hide");
      pick.classList.remove("hide");
      if (level === "schools") renderSchools(); else renderClasses();
    }
    saveSel();
  }

  /* ============================================================
     ĐIỀU HƯỚNG
     ============================================================ */
  function goSchools(){ level = "schools"; selSchoolId = null; selClassId = null; sel = null; render(); }
  function goClasses(sid){
    var s = findSchool(sid);
    if (!s) return;
    selSchoolId = sid; selClassId = null; level = "classes"; sel = null; render();
  }
  function goRoom(cid){
    var s = curSchool();
    if (!s) return;
    var found = null;
    for (var i=0;i<s.classes.length;i++) if (s.classes[i].id === cid) found = s.classes[i];
    if (!found) return;
    selClassId = cid; level = "room"; sel = null; render();
  }
  function goBack(){
    if (level === "room"){ level = "classes"; selClassId = null; }
    else if (level === "classes"){ level = "schools"; selSchoolId = null; selClassId = null; }
    sel = null;
    render();
  }

  /* ============================================================
     TẠO / XOÁ / ĐỔI TÊN TRƯỜNG & LỚP (dùng chung với star-race)
     ============================================================ */
  function hierGuard(p){
    if (busy) return Promise.reject(new Error("BUSY"));
    busy = true;
    return p().then(function(v){ busy = false; return v; },
                    function(e){ busy = false; throw e; });
  }
  function doCreateSchool(name){
    if (!TTDB || typeof TTDB.createSchool !== "function") return Promise.reject(new Error("NO_DB"));
    return hierGuard(function(){ return TTDB.createSchool(FEATURE_ID, name); })
      .then(function(school){
        return TTDB.getHierarchy(FEATURE_ID).then(function(h){
          hier = h;
          goClasses(school.id);
          toast("Đã tạo trường “" + school.name + "” 🏫");
        });
      });
  }
  function doCreateClass(name){
    if (!TTDB || typeof TTDB.createClass !== "function") return Promise.reject(new Error("NO_DB"));
    return hierGuard(function(){ return TTDB.createClass(FEATURE_ID, selSchoolId, name); })
      .then(function(cls){
        return TTDB.getHierarchy(FEATURE_ID).then(function(h){
          hier = h;
          goRoom(cls.id);
          toast("Đã tạo lớp “" + cls.name + "” 📚");
        });
      });
  }
  function doDeleteSchool(sid){
    var s = findSchool(sid);
    if (!s) return;
    if (!confirm("Xoá trường “" + s.name + "”?\n\nCác lớp bên trong cũng bị xoá khỏi danh mục. " +
                 "Dữ liệu xếp chỗ của những lớp đó sẽ không còn truy cập được.")) return;
    hierGuard(function(){ return TTDB.deleteSchool(FEATURE_ID, sid, true); })
      .then(function(){ return TTDB.getHierarchy(FEATURE_ID); })
      .then(function(h){
        hier = h;
        if (selSchoolId === sid){ selSchoolId = null; selClassId = null; level = "schools"; }
        render();
        toast("Đã xoá trường 🗑");
      })
      .catch(function(e){ toast("Không xoá được: " + ((e && (e.code || e.message)) || e)); });
  }
  function doDeleteClass(cid){
    var s = curSchool();
    if (!s) return;
    var c = null;
    for (var i=0;i<s.classes.length;i++) if (s.classes[i].id === cid) c = s.classes[i];
    if (!c) return;
    if (!confirm("Xoá lớp “" + c.name + "”?\n\nDữ liệu xếp chỗ (bàn/tổ/học sinh) của lớp này cũng bị xoá.")) return;
    hierGuard(function(){ return TTDB.deleteClass(FEATURE_ID, selSchoolId, cid); })
      .then(function(){
        if (TTDB && typeof TTDB.deleteSeating === "function"){
          return TTDB.deleteSeating(FEATURE_ID, cid).catch(function(){});
        }
      })
      .then(function(){ return TTDB.getHierarchy(FEATURE_ID); })
      .then(function(h){
        hier = h;
        if (selClassId === cid){ selClassId = null; if (level === "room") level = "classes"; }
        render();
        toast("Đã xoá lớp 🗑");
      })
      .catch(function(e){ toast("Không xoá được: " + ((e && (e.code || e.message)) || e)); });
  }
  function doRenameClass(cid, newName){
    return hierGuard(function(){ return TTDB.renameClassEverywhere(FEATURE_ID, selSchoolId, cid, newName); })
      .then(function(){ return TTDB.getHierarchy(FEATURE_ID); })
      .then(function(h){ hier = h; render(); toast("Đã đổi tên lớp ✏"); })
      .catch(function(e){ toast("Không đổi được tên: " + ((e && (e.code || e.message)) || e)); });
  }

  /* ============================================================
     THAO TÁC TỔ / DÃY
     ============================================================ */
  function promptSplitGroups(){
    var d = curData();
    if (d.groups.length){
      if (!confirm("Lớp này đã có " + d.groups.length + " tổ. Chia lại sẽ giữ nguyên các bàn đang có (gán vào dãy mới). Tiếp tục?")) return;
    }
    var opts = "";
    for (var i=1;i<=8;i++){
      opts += '<button class="cnt-opt" type="button" data-cnt="' + i + '">' + i +
              '<small>dãy</small></button>';
    }
    openModal("🗂 Chia tổ — chọn số lượng dãy",
      '<p style="margin:0 0 12px;font-size:14px;font-weight:700;color:var(--muted)">Mỗi tổ là một dãy bàn theo chiều từ trên xuống. Chọn số tổ:</p>' +
      '<div class="cnt-grid">' + opts + '</div>' +
      '<div class="err" id="mErr"></div>',
      '<button class="btn" type="button" data-close="1">Huỷ</button>',
      function(){
        $$("#mBody .cnt-opt").forEach(function(b){
          b.addEventListener("click", function(){
            var n = parseInt(b.getAttribute("data-cnt"), 10);
            closeModal();
            applySplitGroups(n);
          });
        });
      });
  }
  function applySplitGroups(n){
    var d = curData();
    var existing = d.groups.slice();
    d.groups = [];
    for (var i=0;i<n;i++){
      var g = existing[i] || { id: uid("g"), name: "Tổ " + (i+1), order: i+1 };
      g.order = i+1;
      g.name = "Tổ " + (i+1);
      d.groups.push(g);
    }
    d.tables.forEach(function(t){
      if (!t.groupId && d.groups.length) t.groupId = d.groups[0].id;
    });
    scheduleSave();
    renderRoom();
    toast("Đã chia " + n + " tổ 🗂");
  }

  /* ============================================================
     THAO TÁC BÀN
     ============================================================ */
  /* Thêm bàn: KHÔNG còn hộp thoại chọn loại — loại bàn được chọn trực tiếp
     bằng 4 nút 1/2/3/4 ghế ở cuối mỗi dãy (xem laneHTML + handler data-lane-add). */
  function addTable(groupId, type){
    var d = curData();
    var n = d.tables.length + 1;
    var gid = groupId || (d.groups.length ? d.groups[0].id : null);
    // Không còn toạ độ tự do: bàn tự nối tiếp vào CUỐI dãy nhờ flex column.
    var t = {
      id: uid("t"),
      name: "Bàn " + n,
      type: type || 2,
      groupId: gid,
      students: []
    };
    d.tables.push(t);
    scheduleSave();
    renderRoom();
    toast("Đã thêm " + t.name + " (" + t.type + " ghế)");
  }
  function renameTable(id, newName){
    var t = findTable(id);
    if (!t) return;
    t.name = newName;
    scheduleSave();
    renderRoom();
    toast("Đã đổi tên bàn ✏");
  }
  function changeTableType(id, type){
    var t = findTable(id);
    if (!t) return;
    if (t.students.length > type){
      if (!confirm("Bàn này đang có " + t.students.length + " học sinh nhưng chỉ còn " + type + " ghế. " +
                   "Những học sinh thừa sẽ được bỏ ra khỏi bàn. Tiếp tục?")) return;
      t.students = t.students.filter(function(st){ return st.seat <= type; });
    }
    t.type = type;
    scheduleSave();
    renderRoom();
    toast("Đã đổi loại bàn 🔧");
  }
  function deleteTable(id){
    var t = findTable(id);
    if (!t) return;
    var n = t.students.length;
    if (!confirm("Xoá “" + t.name + "”?" + (n ? "\n\n" + n + " học sinh trong đó cũng bị xoá." : ""))) return;
    var d = curData();
    for (var i=0;i<d.tables.length;i++) if (d.tables[i].id === id){ d.tables.splice(i,1); break; }
    if (sel && sel.tableId === id) sel = null;
    scheduleSave();
    renderRoom();
    toast("Đã xoá bàn 🗑");
  }

  /* ============================================================
     THAO TÁC HỌC SINH
     ============================================================ */
  function promptAddStudent(tableId, seat){
    var t = findTable(tableId);
    if (!t) return;
    var gender = "nam";
    openModal("➕ Thêm học sinh vào “" + t.name + "” (ghế " + seat + ")",
      '<div class="field"><label for="mStuName">Tên học sinh</label>' +
      '<input class="inp" id="mStuName" type="text" maxlength="40" placeholder="Ví dụ: Nguyễn Bảo An" autocomplete="off"></div>' +
      '<div class="field"><label>Giới tính</label>' +
      '<div class="gsel" id="mGender">' +
        '<button type="button" class="on nam" data-g="nam">♂ NAM</button>' +
        '<button type="button" class="nu" data-g="nu">♀ Nữ</button>' +
      '</div></div>' +
      '<div class="err" id="mErr"></div>',
      '<button class="btn" type="button" data-close="1">Huỷ</button>' +
      '<button class="btn primary" type="button" id="mOk">✅ Thêm học sinh</button>',
      function(){
        var inp = $("#mStuName");
        inp.focus();
        $$("#mGender button").forEach(function(b){
          b.addEventListener("click", function(){
            gender = b.getAttribute("data-g");
            $$("#mGender button").forEach(function(x){ x.classList.toggle("on", x === b); });
          });
        });
        function ok(){
          var v = (inp.value || "").trim();
          if (!v){ $("#mErr").textContent = "Bạn nhập tên học sinh giúp mình nhé."; return; }
          closeModal();
          addStudent(tableId, seat, v, gender);
        }
        $("#mOk").addEventListener("click", ok);
        inp.addEventListener("keydown", function(e){ if (e.key === "Enter") ok(); });
      });
  }
  function addStudent(tableId, seat, name, gender){
    var t = findTable(tableId);
    if (!t) return;
    var existing = null;
    for (var i=0;i<t.students.length;i++) if (t.students[i].seat === seat) existing = t.students[i];
    if (existing){
      var free = null;
      for (var s=1;s<=t.type;s++){
        var taken = false;
        for (var j=0;j<t.students.length;j++) if (t.students[j].seat === s) taken = true;
        if (!taken){ free = s; break; }
      }
      if (free) existing.seat = free;
    }
    t.students.push({ id: uid("s"), name: name, gender: gender === "nu" ? "nu" : "nam", seat: seat });
    scheduleSave();
    renderRoom();
    toast("Đã thêm " + name + " " + (gender === "nu" ? "♀" : "♂"));
  }
  function deleteStudent(tableId, seat, sid){
    var t = findTable(tableId);
    if (!t) return;
    for (var i=0;i<t.students.length;i++){
      if (t.students[i].id === sid){ t.students.splice(i,1); break; }
    }
    if (sel && sel.studentId === sid) sel = null;
    scheduleSave();
    renderRoom();
    toast("Đã xoá học sinh 🗑");
  }
  function moveStudent(fromTableId, fromSeat, sid, toTableId, toSeat){
    if (fromTableId === toTableId && fromSeat === toSeat) return;
    var from = findTable(fromTableId);
    var to   = findTable(toTableId);
    if (!from || !to) return;
    var idx = -1;
    for (var i=0;i<from.students.length;i++) if (from.students[i].id === sid) idx = i;
    if (idx < 0) return;
    var st = from.students.splice(idx, 1)[0];
    var occupant = null;
    for (var j=0;j<to.students.length;j++) if (to.students[j].seat === toSeat) occupant = to.students[j];
    if (occupant){
      var free = null;
      for (var s=1;s<=to.type;s++){
        var taken = false;
        for (var k=0;k<to.students.length;k++) if (to.students[k].seat === s) taken = true;
        if (!taken){ free = s; break; }
      }
      if (free) occupant.seat = free;
    }
    st.seat = toSeat;
    to.students.push(st);
    sel = null;
    scheduleSave();
    renderRoom();
    toast("Đã chuyển " + st.name + " sang “" + to.name + "” ⬇");
  }

  /* ============================================================
     HỘP THOẠI
     ============================================================ */
  function promptRenameTable(id){
    var t = findTable(id);
    if (!t) return;
    openModal("✏ Đổi tên bàn",
      '<div class="field"><label for="mSlotName">Tên bàn</label>' +
      '<input class="inp" id="mSlotName" type="text" maxlength="40" value="' + esc(t.name) + '" autocomplete="off"></div>' +
      '<div class="err" id="mErr"></div>',
      '<button class="btn" type="button" data-close="1">Huỷ</button>' +
      '<button class="btn primary" type="button" id="mOk">💾 Lưu tên mới</button>',
      function(){
        var inp = $("#mSlotName");
        inp.focus(); inp.select();
        function ok(){
          var v = (inp.value || "").trim();
          if (!v){ $("#mErr").textContent = "Bạn nhập tên giúp mình nhé."; return; }
          closeModal(); renameTable(id, v);
        }
        $("#mOk").addEventListener("click", ok);
        inp.addEventListener("keydown", function(e){ if (e.key === "Enter") ok(); });
      });
  }
  function promptChangeTableType(id){
    var t = findTable(id);
    if (!t) return;
    var typeOpts = "";
    for (var i=1;i<=4;i++){
      var ico = "";
      for (var j=0;j<i;j++) ico += '<i></i>';
      typeOpts += '<button class="type-opt' + (t.type === i ? " on" : "") + '" type="button" data-type="' + i + '">' +
                  '<span class="to-ico">' + ico + '</span>' + i + ' ghế' +
                  '<small>' + (i===1?"bàn đơn":i===2?"bàn đôi":i===3?"bàn 3 ghế":"bàn 4 ghế") + '</small>' +
                  '</button>';
    }
    openModal("🔧 Đổi loại bàn “" + t.name + "”",
      '<div class="type-grid">' + typeOpts + '</div>' +
      '<div class="err" id="mErr"></div>',
      '<button class="btn" type="button" data-close="1">Huỷ</button>',
      function(){
        $$("#mBody .type-opt").forEach(function(b){
          b.addEventListener("click", function(){
            var type = parseInt(b.getAttribute("data-type"), 10);
            closeModal();
            changeTableType(id, type);
          });
        });
      });
  }
  function promptNewSchool(){
    var box = $("#newSchoolBox");
    if (!box) return;
    box.style.display = "flex";
    var inp = $("#newSchoolName");
    if (inp) inp.focus();
  }
  function promptNewClass(){
    var box = $("#newClassBox");
    if (!box) return;
    box.style.display = "flex";
    var inp = $("#newClassName");
    if (inp) inp.focus();
  }

  /* ============================================================
     SỰ KIỆN — CHỌN TRƯỜNG / LỚP
     ============================================================ */
  $("#pickBody").addEventListener("click", function(e){
    var t = e.target;
    var delSchool = t.closest("[data-delschool]");
    if (delSchool){ e.stopPropagation(); doDeleteSchool(delSchool.getAttribute("data-delschool")); return; }
    var renClass = t.closest("[data-renclass]");
    if (renClass){
      e.stopPropagation();
      var cid = renClass.getAttribute("data-renclass");
      var c = null, s = curSchool();
      if (s) for (var i=0;i<s.classes.length;i++) if (s.classes[i].id === cid) c = s.classes[i];
      if (!c) return;
      openModal("✏ Đổi tên lớp",
        '<div class="field"><label for="mClsName">Tên lớp mới</label>' +
        '<input class="inp" id="mClsName" type="text" maxlength="60" value="' + esc(c.name) + '" autocomplete="off"></div>' +
        '<div class="err" id="mErr"></div>',
        '<button class="btn" type="button" data-close="1">Huỷ</button>' +
        '<button class="btn primary" type="button" id="mOk">💾 Lưu tên mới</button>',
        function(){
          var inp = $("#mClsName");
          inp.focus(); inp.select();
          function ok(){
            var v = (inp.value || "").trim();
            if (!v){ $("#mErr").textContent = "Bạn nhập tên lớp giúp mình nhé."; return; }
            closeModal(); doRenameClass(cid, v);
          }
          $("#mOk").addEventListener("click", ok);
          inp.addEventListener("keydown", function(ev){ if (ev.key === "Enter") ok(); });
        });
      return;
    }
    var delClass = t.closest("[data-delclass]");
    if (delClass){ e.stopPropagation(); doDeleteClass(delClass.getAttribute("data-delclass")); return; }
    if (t.closest("[data-newschool]")){ promptNewSchool(); return; }
    if (t.closest("[data-newclass]")){ promptNewClass(); return; }
    var schoolBtn = t.closest("[data-school]");
    if (schoolBtn){ goClasses(schoolBtn.getAttribute("data-school")); return; }
    var classBtn = t.closest("[data-class]");
    if (classBtn){ goRoom(classBtn.getAttribute("data-class")); return; }
  });

  $("#pickBody").addEventListener("keydown", function(e){
    if (e.key !== "Enter") return;
    var t = e.target;
    if (t.id === "newSchoolName"){
      var v = (t.value || "").trim();
      if (v) doCreateSchool(v).catch(function(err){ toast("Không tạo được: " + ((err && (err.code || err.message)) || err)); });
    } else if (t.id === "newClassName"){
      var v2 = (t.value || "").trim();
      if (v2) doCreateClass(v2).catch(function(err){ toast("Không tạo được: " + ((err && (err.code || err.message)) || err)); });
    }
  });

  $("#pickBody").addEventListener("click", function(e){
    if (e.target.id === "btnCreateSchool"){
      var v = ($("#newSchoolName").value || "").trim();
      if (!v){ toast("Bạn nhập tên trường giúp mình nhé."); return; }
      doCreateSchool(v).catch(function(err){ toast("Không tạo được: " + ((err && (err.code || err.message)) || err)); });
    } else if (e.target.id === "btnCancelSchool"){
      $("#newSchoolBox").style.display = "none";
    } else if (e.target.id === "btnCreateClass"){
      var v2 = ($("#newClassName").value || "").trim();
      if (!v2){ toast("Bạn nhập tên lớp giúp mình nhé."); return; }
      doCreateClass(v2).catch(function(err){ toast("Không tạo được: " + ((err && (err.code || err.message)) || err)); });
    } else if (e.target.id === "btnCancelClass"){
      $("#newClassBox").style.display = "none";
    }
  });

  $("#crumbs").addEventListener("click", function(e){
    var b = e.target.closest("[data-crumb]");
    if (!b) return;
    var to = b.getAttribute("data-crumb");
    if (to === "schools") goSchools();
    else if (to === "classes"){ level = "classes"; selClassId = null; sel = null; render(); }
  });

  $("#btnBack").addEventListener("click", goBack);
  $("#btnHome").addEventListener("click", function(){
    location.href = (location.protocol === "file:") ? "../../home.html" : "/home";
  });

  /* ============================================================
     SỰ KIỆN — PHÒNG HỌC
     ============================================================ */
  $("#btnSplitGroups").addEventListener("click", promptSplitGroups);
  // Nút ĐỔI GÓC NHÌN: xoay vòng 4 hướng (Dưới lên → Trái nhìn sang → Trên xuống → Phải nhìn sang)
  $("#btnRotation").addEventListener("click", function(){
    var idx = V_ORDER.indexOf(vrot);
    var next = V_ORDER[(idx + 1) % V_ORDER.length];
    setRotation(next, true);
    toast("Góc nhìn: " + V_LABEL[next] + " 🔄");
  });
  $("#btnAddTable").addEventListener("click", function(){
    var d = curData();
    if (!d.groups.length){ toast("Hãy chia tổ trước để có dãy đặt bàn 🗂"); return; }
    // Không mở hộp thoại: cuộn tới cuối dãy 1 để bấm chọn loại bàn trực tiếp.
    var box = $("#room .lane .lane-addbox");
    if (box){
      box.scrollIntoView({ behavior:"smooth", block:"center" });
      box.classList.add("flash");
      setTimeout(function(){ box.classList.remove("flash"); }, 1200);
      toast("Bấm số ghế 1/2/3/4 ở cuối dãy để thêm bàn ➕");
    }
  });
  $("#roomEmpty").addEventListener("click", function(e){
    if (e.target.closest("[data-empty-split]")){ promptSplitGroups(); return; }
    if (e.target.closest("[data-empty-add]")){
      var d = curData();
      if (!d.groups.length){ toast("Hãy chia tổ trước để có dãy đặt bàn 🗂"); return; }
      var box = $("#room .lane .lane-addbox");
      if (box){
        box.scrollIntoView({ behavior:"smooth", block:"center" });
        box.classList.add("flash");
        setTimeout(function(){ box.classList.remove("flash"); }, 1200);
        toast("Bấm số ghế 1/2/3/4 ở cuối dãy để thêm bàn ➕");
      }
    }
  });

  $("#room").addEventListener("click", function(e){
    var t = e.target;
    var delStu = t.closest("[data-delstu]");
    if (delStu){
      e.stopPropagation();
      deleteStudent(delStu.getAttribute("data-table"), parseInt(delStu.getAttribute("data-seat"),10), delStu.getAttribute("data-delstu"));
      return;
    }
    var renTable = t.closest("[data-ren-table]");
    if (renTable){ promptRenameTable(renTable.getAttribute("data-ren-table")); return; }
    var typeTable = t.closest("[data-type-table]");
    if (typeTable){ promptChangeTableType(typeTable.getAttribute("data-type-table")); return; }
    var delTable = t.closest("[data-del-table]");
    if (delTable){ deleteTable(delTable.getAttribute("data-del-table")); return; }
    var laneAdd = t.closest("[data-lane-add]");
    if (laneAdd){
      var addType = parseInt(laneAdd.getAttribute("data-add-type"), 10) || 2;
      addTable(laneAdd.getAttribute("data-lane-add"), addType);
      return;
    }

    var seat = t.closest(".seat");
    if (seat){
      var tableId = seat.getAttribute("data-table");
      var seatIdx = parseInt(seat.getAttribute("data-seat"),10);
      var stuId = seat.getAttribute("data-stu");
      // Đang chọn một học sinh → bấm ghế khác để chuyển học sinh đó sang
      if (sel){
        if (sel.tableId === tableId && sel.seat === seatIdx){
          sel = null; // bấm lại đúng ghế → bỏ chọn
        } else {
          moveStudent(sel.tableId, sel.seat, sel.studentId, tableId, seatIdx);
        }
        renderRoom();
        return;
      }
      if (seat.classList.contains("empty")){
        promptAddStudent(tableId, seatIdx);
        return;
      }
      sel = { tableId: tableId, seat: seatIdx, studentId: stuId };
      renderRoom();
      return;
    }
  });

  /* ---- Bàn KHÔNG kéo tự do nữa: layout tự động theo dãy (flex column trong .lane).
     Muốn đổi vị trí bàn → đổi tổ của bàn hoặc xoá/thêm lại; bàn luôn thẳng cột. ---- */

  /* ---- Kéo thả học sinh giữa các ghế ---- */
  var dragStu = null;
  $("#room").addEventListener("mousedown", function(e){
    var seat = e.target.closest(".seat.filled");
    if (!seat) return;
    if (e.target.closest(".s-x")) return;
    var tableId = seat.getAttribute("data-table");
    var seatIdx = parseInt(seat.getAttribute("data-seat"),10);
    var stuId = seat.getAttribute("data-stu");
    e.preventDefault();
    e.stopPropagation();
    dragStu = { tableId: tableId, seat: seatIdx, studentId: stuId };
    seat.classList.add("dragging");
  });
  document.addEventListener("mousemove", function(e){
    if (!dragStu) return;
    var el = $("#room").querySelector('.seat.dragging');
    if (el) el.classList.add("over");
  });
  document.addEventListener("mouseup", function(e){
    if (!dragStu) return;
    var el = $("#room").querySelector('.seat.dragging');
    if (el) el.classList.remove("dragging");
    // Tìm ghế đích dưới con trỏ
    var target = document.elementFromPoint(e.clientX, e.clientY);
    var dst = target ? target.closest(".seat") : null;
    if (dst && dst !== el){
      var toTable = dst.getAttribute("data-table");
      var toSeat = parseInt(dst.getAttribute("data-seat"),10);
      moveStudent(dragStu.tableId, dragStu.seat, dragStu.studentId, toTable, toSeat);
    }
    dragStu = null;
  });

  /* ---- Nút "Huỷ" trong modal ---- */
  $("#mFoot").addEventListener("click", function(e){
    if (e.target.closest("[data-close]")) closeModal();
  });

  /* ============================================================
     KHỞI ĐỘNG
     ============================================================ */
  function renderLoading(){
    $("#pickBody").innerHTML = '<div class="hempty">⏳ Đang tải danh mục trường &amp; lớp…</div>';
  }
  function boot(){
    loadSel();
    loadRot();
    setRotation(vrot, false);
    renderLoading();
    var ensure = (TTDB && typeof TTDB.init === "function")
      ? (TTDB._state && TTDB._state.ready ? Promise.resolve(true)
          : TTDB.init().then(function(){ return true; }).catch(function(){ return false; }))
      : Promise.resolve(false);
    ensure.then(function(){
      var ready = (TTDB && typeof TTDB.getHierarchy === "function")
        ? TTDB.getHierarchy(FEATURE_ID).then(function(h){ hier = h || hier; })
        : Promise.resolve();
      var seatReady = (TTDB && typeof TTDB.getSeating === "function")
        ? TTDB.getSeating(FEATURE_ID).then(function(d){ seating = d || seating; })
        : Promise.resolve();
      return Promise.all([ready.catch(function(){}), seatReady.catch(function(){})]);
    }).then(function(){
      render();
    });
  }
  window.addEventListener("pagehide", function(){ if (saveTimer) flushSave(); });
  document.addEventListener("visibilitychange", function(){ if (document.hidden && saveTimer) flushSave(); });

  if (typeof TTDB === "undefined"){
    renderLoading();
    toast("Không nạp được js/db.js — bạn tải lại trang giúp mình nhé.");
  } else {
    boot();
  }
})();
