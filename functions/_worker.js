/**
 * StegaLoom Pro — Cloudflare Pages Function
 * 
 * 位置: functions/_worker.js
 * CF Pages 自动将此文件作为 Worker 函数，处理 /api/* 请求
 */

import { embedWatermark, detectWatermark } from './watermark-core';

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
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export async function onRequest(context) {
  const r = context.request;
  const url = new URL(r.url);
  const ip = r.headers.get('CF-Connecting-IP') || 'x';

  if (r.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (url.pathname === '/api/health')
    return json({ status: 'ok', version: '3.2.0', service: 'StegaLoom Pro (CF)', timestamp: Date.now() });

  if (!checkRL(ip)) return json({ success: false, error: '请求过于频繁' }, 429);

  let body;
  try { body = await r.json(); } catch { return json({ success: false, error: '格式错误' }, 400); }

  const imgB64 = (body.image || '').trim();
  if (!imgB64) return json({ success: false, error: '缺少 image 参数' }, 400);

  let imgBytes;
  try {
    let d = imgB64.includes(',') ? imgB64.split(',')[1] : imgB64;
    imgBytes = Uint8Array.from(atob(d), c => c.charCodeAt(0));
  } catch { return json({ success: false, error: '图片解码失败' }, 400); }

  if (url.pathname === '/api/embed' && r.method === 'POST') {
    const text = (body.text || '').trim();
    if (!text) return json({ success: false, error: '缺少 text 参数' }, 400);
    const bp = parseInt(body.bitplane) || 1;
    const seed = body.seed || '';
    try {
      const res = await embedWatermark(imgBytes, text, bp, seed);
      return json({ success: true, image: btoa(String.fromCharCode(...res)), format: 'png', size_bytes: res.length, bitplane: bp, has_password: !!seed });
    } catch (e) { return json({ success: false, error: e.message }, 400); }
  }

  if (url.pathname === '/api/detect' && r.method === 'POST') {
    const bp = parseInt(body.bitplane) || 3;
    const seed = body.seed || '';
    try {
      const res = await detectWatermark(imgBytes, bp, seed);
      return json({ success: res.success, text: res.text || '', score: res.score || 0, bitplane: res.bp ?? -1, seed_used: res.seed_used || '' });
    } catch (e) { return json({ success: false, error: '检测失败' }, 500); }
  }

  return json({ error: 'Not Found' }, 404);
}
