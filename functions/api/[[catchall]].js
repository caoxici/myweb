/**
 * StegaLoom Pro — Cloudflare Pages Functions
 * 
 * 位置: functions/api/[[catchall]].js
 * 处理 /api/* 所有请求
 */

import { embedWatermark, detectWatermark } from '../watermark-core';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const rl = new Map();
function checkRL(ip) {
  const now = Date.now();
  const e = rl.get(ip);
  if (!e || now - e.t > 1000) { rl.set(ip, { t: now, c: 1 }); return true; }
  if (e.c >= 10) return false;
  e.c++; return true;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { 
    status, 
    headers: { ...CORS, 'Content-Type': 'application/json' } 
  });
}

export async function onRequest(context) {
  const r = context.request;
  const url = new URL(r.url);
  const path = url.pathname;
  const ip = r.headers.get('CF-Connecting-IP') || 'x';

  // Handle CORS preflight
  if (r.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Health check
  if (path === '/api/health') {
    return json({ 
      status: 'ok', 
      version: '4.0.0', 
      service: 'StegaLoom Pro (CF) - Anti-Crop', 
      timestamp: Date.now() 
    });
  }

  // Rate limiting
  if (!checkRL(ip)) {
    return json({ success: false, error: '请求过于频繁' }, 429);
  }

  // Only POST for embed/detect
  if (r.method !== 'POST') {
    return json({ success: false, error: '需要 POST 方法' }, 405);
  }

  // Parse request body
  let body;
  try {
    body = await r.json();
  } catch {
    return json({ success: false, error: 'JSON 格式错误' }, 400);
  }

  const imgB64 = (body.image || '').trim();
  if (!imgB64) {
    return json({ success: false, error: '缺少 image 参数' }, 400);
  }

  // Decode image
  let imgBytes;
  try {
    let d = imgB64.includes(',') ? imgB64.split(',')[1] : imgB64;
    imgBytes = Uint8Array.from(atob(d), c => c.charCodeAt(0));
  } catch {
    return json({ success: false, error: '图片 Base64 解码失败' }, 400);
  }

  // Route to handler
  try {
    if (path === '/api/embed') {
      const text = (body.text || '').trim();
      if (!text) return json({ success: false, error: '缺少 text 参数' }, 400);
      if (text.length > 5000) return json({ success: false, error: 'text 过长' }, 400);

      const bp = parseInt(body.bitplane) || 1;
      const seed = body.seed || '';

      const result = embedWatermark(imgBytes, text, bp, seed);
      return json({
        success: true,
        image: result.image,
        format: 'png',
        size_bytes: result.size_bytes,
        bitplane: bp,
        has_password: Boolean(seed),
      });
    }

    if (path === '/api/detect') {
      const bp = parseInt(body.bitplane) || 3;
      const seed = body.seed || '';

      const result = detectWatermark(imgBytes, bp, seed);
      return json({
        success: result.success,
        text: result.text || '',
        score: result.score || 0,
        bitplane: result.bp ?? -1,
        seed_used: result.seed_used || '',
      });
    }

    return json({ success: false, error: '未知路径: ' + path }, 404);
  } catch (e) {
    return json({ success: false, error: e.message || '服务内部错误' }, 500);
  }
}
