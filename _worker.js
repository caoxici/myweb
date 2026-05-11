/**
 * StegaLoom Pro — Cloudflare Pages + Workers 集成入口
 *
 * 此文件使 Cloudflare Pages 自动将 /api/* 请求转发给 Worker。
 * 文件名固定为 _worker.js，放在 Pages 项目的根目录。
 *
 * 部署方式:
 *   1. 在 GitHub 创建仓库，推送此目录所有文件
 *   2. Cloudflare Dashboard → Workers & Pages → 创建 → 连接到 Git
 *   3. 选择仓库，构建命令留空，输出目录留空
 *   4. 部署完成后，Pages 自动托管 digital-watermark.html
 *   5. /api/* 由 _worker.js 处理
 */

import { embedWatermark, detectWatermark } from './watermark-core';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rate limit per IP
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

async function handle(r) {
  const url = new URL(r.url);
  const ip = r.headers.get('CF-Connecting-IP') || 'x';

  if (r.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (url.pathname === '/api/health')
    return json({ status: 'ok', version: '3.2.0', service: 'StegaLoom Pro (CF)', timestamp: Date.now() });

  if (!checkRL(ip)) return json({ success: false, error: '请求过于频繁' }, 429);

  let body;
  try { body = await r.json(); } catch { return json({ success: false, error: '格式错误' }, 400); }

  const imgB64 = (body.image || '').trim();
  if (!imgB64) return json({ success: false, error: '缺少 image' }, 400);

  let imgBytes;
  try {
    let d = imgB64.includes(',') ? imgB64.split(',')[1] : imgB64;
    imgBytes = Uint8Array.from(atob(d), c => c.charCodeAt(0));
  } catch (e) { return json({ success: false, error: '图片解码失败' }, 400); }

  if (url.pathname === '/api/embed' && r.method === 'POST') {
    const text = (body.text || '').trim();
    if (!text) return json({ success: false, error: '缺少 text' }, 400);
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

export default { fetch: (r) => handle(r).catch(e => json({ error: 'Internal: ' + e.message }, 500)) };
