#!/usr/bin/env node
/**
 * tools/quota-report.js
 * ---------------------------------------------------------------------------
 * Đọc số reads/writes THẬT của Firestore từ Google Cloud Monitoring API và
 * so sánh với ước tính của tính năng star-race.
 *
 * DÙNG:
 *   node tools/quota-report.js --key=serviceAccount.json --days=7
 *   node tools/quota-report.js --key=sa.json --days=30 --project=teachtool-aadf1
 *   node tools/quota-report.js --key=sa.json --days=7 --out=quota.csv
 *
 * QUYỀN CẦN THIẾT (chỉ ĐỌC, không ghi gì vào Firebase):
 *   roles/monitoring.viewer  (Monitoring Viewer)
 *   → KHÔNG cần Firestore role, KHÔNG cần quyền ghi, KHÔNG đụng dữ liệu học sinh.
 *
 * METRIC DÙNG:
 *   firestore.googleapis.com/document/read_count
 *   firestore.googleapis.com/document/write_count
 *   firestore.googleapis.com/document/delete_count
 *   firestore.googleapis.com/network/egress_bytes_count   (nếu có)
 *
 * LƯU Ý VỀ ĐỘ TRỄ: Cloud Monitoring tổng hợp theo cửa sổ 60 s và có thể trễ
 * 2–5 phút. Số của "hôm nay" vì vậy luôn thấp hơn thực tế một chút.
 *
 * CẢNH BÁO: file key là bí mật. KHÔNG commit. .gitignore đã chặn
 * serviceAccount*.json / *-key.json / .secrets/.
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------ tham số CLI ------------------------------ */

function parseArgs(argv) {
  const out = { days: 7, out: null, project: null, key: null, json: false };
  for (const a of argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const k = m[1];
    const v = m[2];
    if (k === 'key') out.key = v;
    else if (k === 'days') out.days = parseInt(v, 10);
    else if (k === 'out') out.out = v;
    else if (k === 'project') out.project = v;
    else if (k === 'json') out.json = true;
    else if (k === 'help' || k === 'h') out.help = true;
  }
  return out;
}

const USAGE = `
Đọc reads/writes Firestore thật từ Google Cloud Monitoring.

  node tools/quota-report.js --key=serviceAccount.json --days=7

Tham số:
  --key=<path>      Đường dẫn file service account JSON (bắt buộc)
  --days=<n>        Số ngày gần nhất (mặc định 7, tối đa 90)
  --project=<id>    GCP project id (mặc định: lấy từ file key)
  --out=<path>      Ghi CSV ra file (mặc định: in ra màn hình)
  --json            In JSON thay vì bảng

Tạo service account:
  1. console.cloud.google.com → chọn project của Firebase
  2. IAM & Admin → Service Accounts → Create service account
  3. Tên: quota-reader  → Create and continue
  4. Role: "Monitoring Viewer" (roles/monitoring.viewer)  → Continue → Done
  5. Bấm vào account → Keys → Add key → Create new key → JSON → tải về
  6. Đặt file NGOÀI repo, hoặc trong .secrets/ (đã gitignore)

  node tools/quota-report.js --key=.secrets/sa.json --days=7
`;

/* --------------------------- service account auth ------------------------ */

/**
 * Lấy access token từ service account JSON bằng JWT assertion (RS256).
 * Không dùng thư viện ngoài: chỉ cần `crypto` có sẵn của Node.
 */
async function getAccessToken(sa) {
  const crypto = require('crypto');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/monitoring.read',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const b64u = (o) =>
    Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const unsigned = b64u(header) + '.' + b64u(claim);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const assertion = unsigned + '.' + sig;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('Không lấy được access token: ' + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

/* ------------------------------ Monitoring ------------------------------- */

const METRICS = [
  { key: 'reads',   metric: 'firestore.googleapis.com/document/read_count' },
  { key: 'writes',  metric: 'firestore.googleapis.com/document/write_count' },
  { key: 'deletes', metric: 'firestore.googleapis.com/document/delete_count' },
  { key: 'egress',  metric: 'firestore.googleapis.com/network/egress_bytes_count' }
];

/**
 * Gọi timeSeries.list cho một metric, trả về map "YYYY-MM-DD" -> tổng.
 * Dùng ALIGN_SUM + alignmentPeriod 86400s để mỗi điểm là một ngày.
 */
async function fetchDaily(token, project, metric, days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);

  const params = new URLSearchParams({
    filter: `metric.type="${metric}" AND resource.type="firestore.googleapis.com/Database"`,
    'interval.startTime': start.toISOString(),
    'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': '86400s',
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM'
  });

  const url = `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${params}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();

  if (!res.ok) {
    const msg = (data.error && data.error.message) || res.status;
    // Metric không tồn tại (vd egress ở một số project) → trả rỗng, không chết.
    if (res.status === 400 || res.status === 404) {
      return { ok: false, reason: msg, daily: {} };
    }
    throw new Error('Monitoring API lỗi: ' + msg);
  }

  const daily = {};
  for (const series of data.timeSeries || []) {
    for (const p of series.points || []) {
      // interval.endTime là mốc kết thúc cửa sổ 1 ngày → lấy ngày của nó.
      const day = String(p.interval.endTime).slice(0, 10);
      const v = p.value;
      const n = v.int64Value != null ? Number(v.int64Value)
              : v.doubleValue != null ? Number(v.doubleValue)
              : 0;
      daily[day] = (daily[day] || 0) + n;
    }
  }
  return { ok: true, daily };
}

/* ------------------------------- ước tính -------------------------------- */

/**
 * Ước tính reads/ngày của MỘT giáo viên dùng star-race, theo đúng mô hình
 * đã đo bằng emulator (xem docs/quota-verification.md):
 *
 *   mở trang lạnh   = N nhóm + 1 (hierarchy)
 *   mỗi F5 trong 60s = 0 (cache)
 *   mỗi vòng poll    = 1 read
 *   1 tiết 45 phút   = 180 vòng poll (15 s)
 *
 * Giả định mặc định: 5 lớp × 6 nhóm = 30 nhóm, 5 tiết/ngày, 2 lần F5/tiết.
 */
function estimatePerTeacher(opts) {
  const o = Object.assign({ groups: 30, lessons: 5, reloads: 2, pollSec: 15 }, opts || {});
  const pollsPerLesson = Math.floor((45 * 60) / o.pollSec);
  const perLesson = o.groups + 1 + pollsPerLesson + 0;   // F5 trong 60s = 0
  return {
    perLesson,
    perDay: perLesson * o.lessons,
    pollsPerLesson
  };
}

/* --------------------------------- main ---------------------------------- */

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) { console.log(USAGE); return; }
  if (!args.key) {
    console.error('Thiếu --key=<serviceAccount.json>\n' + USAGE);
    process.exit(2);
  }

  const keyPath = path.resolve(args.key);
  if (!fs.existsSync(keyPath)) {
    console.error('Không thấy file key: ' + keyPath);
    process.exit(2);
  }

  let sa;
  try {
    sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (e) {
    console.error('File key không phải JSON hợp lệ: ' + e.message);
    process.exit(2);
  }
  if (!sa.client_email || !sa.private_key) {
    console.error('File key thiếu client_email / private_key — có phải service account JSON không?');
    process.exit(2);
  }

  const project = args.project || sa.project_id;
  if (!project) {
    console.error('Không xác định được project id — thêm --project=<id>');
    process.exit(2);
  }

  const days = Math.min(Math.max(args.days || 7, 1), 90);

  console.log(`Project : ${project}`);
  console.log(`Khoảng  : ${days} ngày gần nhất`);
  console.log(`Key     : ${sa.client_email}`);
  console.log('');

  const token = await getAccessToken(sa);

  const collected = {};
  const missing = [];
  for (const m of METRICS) {
    process.stdout.write(`Đang đọc ${m.key}… `);
    const r = await fetchDaily(token, project, m.metric, days);
    if (r.ok) {
      collected[m.key] = r.daily;
      const total = Object.values(r.daily).reduce((a, b) => a + b, 0);
      console.log('OK (' + total.toLocaleString('vi-VN') + ')');
    } else {
      collected[m.key] = {};
      missing.push(m.key + ': ' + r.reason);
      console.log('KHÔNG CÓ (' + r.reason + ')');
    }
  }

  // Hợp nhất các ngày
  const allDays = new Set();
  for (const k of Object.keys(collected)) {
    for (const d of Object.keys(collected[k])) allDays.add(d);
  }
  const dayList = Array.from(allDays).sort();

  if (!dayList.length) {
    console.log('\nKhông có dữ liệu. Nguyên nhân thường gặp:');
    console.log('  • Project chưa có traffic Firestore trong khoảng này');
    console.log('  • Service account thiếu role Monitoring Viewer');
    console.log('  • Metric chưa được bật cho project');
    if (missing.length) console.log('  • ' + missing.join('\n  • '));
    process.exit(1);
  }

  const est = estimatePerTeacher();

  // ---- Bảng ----
  const rows = dayList.map((d) => {
    const reads = collected.reads[d] || 0;
    const writes = collected.writes[d] || 0;
    const deletes = collected.deletes[d] || 0;
    const egress = collected.egress[d] || 0;
    return {
      day: d,
      reads,
      writes,
      deletes,
      egressMB: Math.round(egress / 1048576 * 10) / 10,
      teachers: reads ? Math.round(reads / est.perDay * 10) / 10 : 0,
      pctSpark: reads ? Math.round(reads / 50000 * 1000) / 10 : 0
    };
  });

  if (args.json) {
    console.log(JSON.stringify({ project, days, estimate: est, rows, missing }, null, 2));
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    const padL = (s, n) => String(s).padStart(n);
    console.log('');
    console.log(pad('Ngày', 12) + padL('reads', 10) + padL('writes', 9) +
                padL('deletes', 9) + padL('egress MB', 11) +
                padL('GV ước tính', 14) + padL('% Spark', 10));
    console.log('-'.repeat(75));
    for (const r of rows) {
      console.log(pad(r.day, 12) + padL(r.reads.toLocaleString('vi-VN'), 10) +
                  padL(r.writes.toLocaleString('vi-VN'), 9) +
                  padL(r.deletes.toLocaleString('vi-VN'), 9) +
                  padL(r.egressMB, 11) + padL(r.teachers, 14) + padL(r.pctSpark + '%', 10));
    }
    console.log('-'.repeat(75));

    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    console.log(pad('TỔNG', 12) + padL(sum('reads').toLocaleString('vi-VN'), 10) +
                padL(sum('writes').toLocaleString('vi-VN'), 9) +
                padL(sum('deletes').toLocaleString('vi-VN'), 9) +
                padL(Math.round(sum('egressMB') * 10) / 10, 11));

    console.log('');
    console.log('Ước tính star-race (1 GV, 30 nhóm, 5 tiết/ngày, poll 15 s):');
    console.log('  ' + est.perLesson + ' reads/tiết  →  ' + est.perDay + ' reads/ngày');
    console.log('  Ngưỡng Spark 50.000 reads/ngày  →  tối đa ~' +
                Math.floor(50000 / est.perDay) + ' GV');
    console.log('');
    console.log('Cách đọc bảng:');
    console.log('  • "GV ước tính" = reads ÷ ' + est.perDay + ' — số giáo viên tương đương.');
    console.log('    Nếu con số này LỚN hơn số GV thật của bạn, thì có traffic khác');
    console.log('    (tính năng khác, hoặc vòng poll bị nhân lên do nhiều tab).');
    console.log('  • "% Spark" = reads ÷ 50.000. Trên 80% là phải xử lý.');
    console.log('  • Cloud Monitoring trễ 2–5 phút và bỏ sót phần cuối ngày hôm nay.');
  }

  if (args.out) {
    const csv = ['ngay,reads,writes,deletes,egress_mb,gv_uoc_tinh,pct_spark']
      .concat(rows.map((r) => [r.day, r.reads, r.writes, r.deletes, r.egressMB, r.teachers, r.pctSpark].join(',')))
      .join('\n');
    fs.writeFileSync(path.resolve(args.out), csv + '\n', 'utf8');
    console.log('\nĐã ghi CSV: ' + path.resolve(args.out));
  }
}

main().catch((e) => {
  console.error('\nLỖI: ' + e.message);
  if (/403|PERMISSION_DENIED|permission/i.test(e.message)) {
    console.error('→ Service account thiếu role. Cần: roles/monitoring.viewer (Monitoring Viewer).');
  }
  process.exit(1);
});
