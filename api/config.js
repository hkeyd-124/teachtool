/**
 * TeachTool — runtime config endpoint (Vercel Serverless Function)
 *
 * Trả về JSON cấu hình công khai cho client.
 * Toàn bộ giá trị đọc từ ENVIRONMENT VARIABLES của Vercel — KHÔNG hardcode key
 * trong source code. Nếu biến chưa được đặt, trường tương ứng là null và
 * ứng dụng vẫn chạy ở chế độ chỉ-lưu-trên-máy (localStorage).
 *
 * Các biến môi trường cần đặt trên Vercel (xem .env.example):
 *   FIREBASE_API_KEY
 *   FIREBASE_AUTH_DOMAIN
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_STORAGE_BUCKET
 *   FIREBASE_MESSAGING_SENDER_ID
 *   FIREBASE_APP_ID
 *   FIREBASE_MEASUREMENT_ID            (tùy chọn)
 *   FIREBASE_SERVICE_ACCOUNT_JSON      (private key — CHỈ dùng server-side, KHÔNG trả ra client)
 */

"use strict";

function pick(name) {
  const v = process.env[name];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function handler(req, res) {
  // Chỉ trả cấu hình công khai của Firebase Web SDK.
  // TUYỆT ĐỐI không trả FIREBASE_SERVICE_ACCOUNT_JSON hay bất kỳ private key nào.
  const publicConfig = {
    apiKey: pick("FIREBASE_API_KEY"),
    authDomain: pick("FIREBASE_AUTH_DOMAIN"),
    projectId: pick("FIREBASE_PROJECT_ID"),
    storageBucket: pick("FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: pick("FIREBASE_MESSAGING_SENDER_ID"),
    appId: pick("FIREBASE_APP_ID"),
    measurementId: pick("FIREBASE_MEASUREMENT_ID"),
  };

  const configured = Boolean(publicConfig.apiKey && publicConfig.projectId);

  const payload = {
    firebase: configured ? publicConfig : null,
    // Cho client biết có backend đám mây hay không, để hiển thị trạng thái phù hợp.
    cloud: configured,
    // Có service account ở server hay không (chỉ là cờ boolean, không lộ nội dung).
    serverAdmin: Boolean(pick("FIREBASE_SERVICE_ACCOUNT_JSON")),
    env: process.env.VERCEL_ENV || "development",
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  res.status(200).json(payload);
}

module.exports = handler;
