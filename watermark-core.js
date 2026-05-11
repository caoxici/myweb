/**
 * StegaLoom Core — Cloudflare Workers 版 LSB 暗水印引擎
 *
 * 设计要点：
 * - 兼容 CF Workers 运行时 (Service Worker API)
 * - 无外部依赖，纯 JS
 * - 使用 OffscreenCanvas 处理图片（Workers 中可用）
 * - 顺序嵌入+密码偏移，与之前 Python 版算法一致
 */

// ── 常量 ──
const MAX_TEXT_LENGTH = 5000;
const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB
const SEQUENCE_OFFSET = 500;
const MAX_READ_BITS = 30000;

// ── 文本 ⇄ 比特流 ──

function textToBits(text) {
  const encoded = new TextEncoder().encode(text);
  const bits = [];
  // 32-bit length header
  for (let i = 31; i >= 0; i--) bits.push((encoded.length >> i) & 1);
  // Data bytes
  for (const b of encoded) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  }
  return bits;
}

function bitsToText(bits) {
  if (bits.length < 32) return '';
  let length = 0;
  for (let i = 0; i < 32; i++) length = (length << 1) | (bits[i] & 1);
  if (length <= 0 || length > MAX_TEXT_LENGTH) return '';
  const total = length * 8;
  if (bits.length < 32 + total) return '';
  const bytes = new Uint8Array(length);
  for (let i = 0; i < total; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[32 + i + j] & 1);
    bytes[i / 8] = b;
  }
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

// ── 密码偏移 ──

function calcOffset(seed, pixelCount) {
  if (!seed) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  const max = pixelCount - SEQUENCE_OFFSET;
  return max > 0 ? ((h >>> 0) % max) : 0;
}

// ── 图片处理 (Workers 中操作像素) ──

async function imageToRGBA(imageBytes) {
  const img = await createImageBitmap(new Blob([imageBytes]));
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return { canvas, ctx, imageData, width: img.width, height: img.height };
}

// ── LSB 嵌入 ──

async function embedWatermark(imageBytes, text, bitplane = 1, seed = '') {
  if (bitplane < 0 || bitplane > 2) throw new Error(`位平面 ${bitplane} 不支持`);
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`文本过长 (${text.length}字符)`);

  const { canvas, ctx, imageData, width, height } = await imageToRGBA(imageBytes);
  const data = imageData.data;
  const pixelCount = width * height;
  if (pixelCount > 20_000_000) throw new Error('图片过大');

  const bits = textToBits(text);
  if (bits.length > pixelCount) throw new Error('比特数超过图片容量');

  const offset = calcOffset(seed, pixelCount);
  const mask = 1 << bitplane;

  for (let i = 0; i < bits.length; i++) {
    const idx = (offset + i) * 4; // R channel
    if (idx >= data.length) break;
    data[idx] = bits[i] === 1 ? (data[idx] | mask) : (data[idx] & ~mask);
  }

  ctx.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// ── LSB 提取 ──

async function detectWatermark(imageBytes, bitplane = 3, seed = '') {
  const { imageData, width, height } = await imageToRGBA(imageBytes);
  const data = imageData.data;
  const pixelCount = width * height;

  if (bitplane === 3) {
    // Auto-scan mode
    const candidates = [];
    for (const bp of [0, 1, 2]) {
      for (const s of [seed, '']) {
        const result = tryExtract(data, pixelCount, bp, s);
        if (result && result.score > 70) candidates.push(result);
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return { success: true, ...candidates[0] };
    }
    return { success: false, text: '', score: 0, bp: -1, seed_used: '' };
  }

  const result = tryExtract(data, pixelCount, bitplane, seed);
  if (result && result.score > 70) return { success: true, ...result };
  return { success: false, text: '', score: 0, bp: bitplane, seed_used: seed || '(无密码)' };
}

function tryExtract(data, pixelCount, bp, seed) {
  const offset = calcOffset(seed, pixelCount);
  const mask = 1 << bp;
  const readCount = Math.min(MAX_READ_BITS, pixelCount - offset);
  if (readCount < 40) return null;

  const bits = new Uint8Array(readCount);
  for (let i = 0; i < readCount; i++) {
    bits[i] = (data[(offset + i) * 4] & mask) ? 1 : 0;
  }

  // Progressive decode
  let bestText = '';
  let bestScore = 0;

  for (let lenBytes = 1; lenBytes <= Math.min(MAX_TEXT_LENGTH, (readCount - 32) >> 3); lenBytes++) {
    const totalBits = 32 + lenBytes * 8;
    if (totalBits > readCount) break;

    // Verify length header
    let lenCheck = 0;
    for (let j = 0; j < 32; j++) lenCheck = (lenCheck << 1) | bits[j];
    if (lenCheck !== lenBytes) continue;

    // Decode
    const raw = new Uint8Array(lenBytes);
    for (let i = 0; i < lenBytes; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[32 + i * 8 + j];
      raw[i] = b;
    }

    let text;
    try { text = new TextDecoder().decode(raw); } catch { continue; }

    // Verify consistency
    const reBits = textToBits(text);
    let matches = 0;
    for (let i = 0; i < reBits.length && i < readCount; i++) {
      if (reBits[i] === bits[i]) matches++;
    }
    const ratio = Math.round((matches / reBits.length) * 100);
    if (ratio >= 70 && text.length > bestText.length) {
      bestText = text;
      bestScore = ratio;
    }
  }

  if (bestText) {
    return { text: bestText, score: bestScore, bp: bp, seed_used: seed || '(无密码)' };
  }
  return null;
}

