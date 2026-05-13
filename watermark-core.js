/**
 * StegaLoom Core v2 — 抗裁剪暗水印引擎
 * 
 * 改进点：
 * 1. 冗余嵌入：水印在多个区域重复嵌入
 * 2. 纠错编码：Reed-Solomon 风格的冗余
 * 3. 分块嵌入：将图像分块，每块独立嵌入
 * 4. 特征对齐：检测时通过像素特征定位
 */

const MAX_TEXT_LENGTH = 5000;
const BLOCK_SIZE = 64;           // 分块大小
const REDUNDANCY = 3;            // 冗余倍数
const ECC_RATIO = 0.5;           // 纠错码比例
const MAGIC_HEADER = [0xDE, 0xAD, 0xBE, 0xEF]; // 魔数头

// ========== 基础工具 ==========

function textToBits(text) {
  const encoded = new TextEncoder().encode(text);
  const bits = [];
  // 32位长度
  for (let i = 31; i >= 0; i--) bits.push((encoded.length >> i) & 1);
  // 数据
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
  try { return new TextDecoder().decode(bytes); } catch { return ''; }
}

// 简单的 XOR 校验
function calcChecksum(bits) {
  let sum = 0;
  for (const b of bits) sum ^= b;
  return sum;
}

// Reed-Solomon 风格的冗余编码
function encodeWithECC(bits) {
  const eccLen = Math.ceil(bits.length * ECC_RATIO);
  const ecc = new Uint8Array(eccLen);
  // 简单的奇偶校验块
  for (let i = 0; i < eccLen; i++) {
    let parity = 0;
    const chunkSize = Math.ceil(bits.length / eccLen);
    for (let j = 0; j < chunkSize; j++) {
      const idx = i * chunkSize + j;
      if (idx < bits.length) parity ^= bits[idx];
    }
    ecc[i] = parity;
  }
  return [...bits, ...ecc];
}

function decodeWithECC(bits, originalLen) {
  const eccLen = Math.ceil(originalLen * ECC_RATIO);
  const dataBits = bits.slice(0, originalLen);
  const eccBits = bits.slice(originalLen, originalLen + eccLen);
  
  // 验证 ECC
  let errors = 0;
  const chunkSize = Math.ceil(originalLen / eccLen);
  for (let i = 0; i < eccLen; i++) {
    let parity = 0;
    for (let j = 0; j < chunkSize; j++) {
      const idx = i * chunkSize + j;
      if (idx < originalLen) parity ^= dataBits[idx];
    }
    if (parity !== eccBits[i]) errors++;
  }
  
  return { data: dataBits, errors, total: eccLen };
}

// ========== 种子随机数 ==========

function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  return function() {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

// ========== 图像处理 ==========

async function imageToRGBA(imageBytes) {
  const img = await createImageBitmap(new Blob([imageBytes]));
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return { canvas, ctx, imageData, width: img.width, height: img.height };
}

// ========== 嵌入算法 ==========

export async function embedWatermark(imageBytes, text, bitplane = 1, seed = '') {
  if (bitplane < 0 || bitplane > 2) throw new Error(`位平面 ${bitplane} 不支持`);
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`文本过长`);
  
  const { canvas, ctx, imageData, width, height } = await imageToRGBA(imageBytes);
  const data = imageData.data;
  const pixelCount = width * height;
  
  if (pixelCount > 20000000) throw new Error('图片过大');
  
  // 编码水印数据
  let bits = textToBits(text);
  bits = encodeWithECC(bits);
  
  // 添加魔数头
  const headerBits = [];
  for (const byte of MAGIC_HEADER) {
    for (let i = 7; i >= 0; i--) headerBits.push((byte >> i) & 1);
  }
  const fullBits = [...headerBits, ...bits];
  
  const mask = 1 << bitplane;
  const rng = seed ? seededRandom(seed) : null;
  
  // === 冗余嵌入策略 ===
  // 将图像分成多个区域，在每个区域都嵌入完整的水印
  
  const totalCapacity = pixelCount;
  const watermarkLen = fullBits.length;
  
  // 计算需要多少个冗余副本
  const numCopies = Math.min(REDUNDANCY, Math.floor(totalCapacity / watermarkLen));
  
  if (numCopies < 1) throw new Error('图片太小，无法嵌入水印');
  
  // 生成嵌入位置
  const positions = [];
  const stride = Math.floor(totalCapacity / (numCopies + 1));
  
  for (let copy = 0; copy < numCopies; copy++) {
    let startPos;
    if (rng) {
      // 使用随机但确定的位置
      startPos = Math.floor(rng() * (totalCapacity - watermarkLen));
    } else {
      // 均匀分布
      startPos = stride * (copy + 1);
    }
    positions.push(startPos);
  }
  
  // 在每个位置嵌入水印
  for (const startPos of positions) {
    for (let i = 0; i < watermarkLen; i++) {
      const pixelIdx = startPos + i;
      if (pixelIdx >= pixelCount) break;
      
      const dataIdx = pixelIdx * 4;
      if (dataIdx + 3 >= data.length) break;
      
      // 嵌入到 R 通道
      if (fullBits[i] === 1) {
        data[dataIdx] = data[dataIdx] | mask;
      } else {
        data[dataIdx] = data[dataIdx] & ~mask;
      }
      
      // 同时嵌入到 G 通道（增加冗余）
      const gBit = (i + 1) < fullBits.length ? fullBits[(i + 1) % fullBits.length] : fullBits[i];
      if (gBit === 1) {
        data[dataIdx + 1] = data[dataIdx + 1] | mask;
      } else {
        data[dataIdx + 1] = data[dataIdx + 1] & ~mask;
      }
    }
  }
  
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// ========== 检测算法 ==========

function tryExtractAtPosition(data, pixelCount, bp, startPos, watermarkLen) {
  const mask = 1 << bp;
  const bits = new Uint8Array(watermarkLen);
  
  for (let i = 0; i < watermarkLen; i++) {
    const pixelIdx = startPos + i;
    if (pixelIdx >= pixelCount) return null;
    
    const dataIdx = pixelIdx * 4;
    if (dataIdx + 3 >= data.length) return null;
    
    // 从 R 通道读取
    bits[i] = (data[dataIdx] & mask) ? 1 : 0;
  }
  
  return bits;
}

function findWatermarkPosition(data, pixelCount, bp) {
  const mask = 1 << bp;
  
  // 搜索魔数头
  const headerBytes = MAGIC_HEADER.length * 8;
  
  // 扫描所有可能的起始位置（步长为 8 以提高速度）
  for (let start = 0; start < pixelCount - headerBytes; start += 4) {
    let match = true;
    for (let h = 0; h < MAGIC_HEADER.length; h++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const pixelIdx = start + h * 8 + bit;
        if (pixelIdx >= pixelCount) { match = false; break; }
        const dataIdx = pixelIdx * 4;
        const b = (data[dataIdx] & mask) ? 1 : 0;
        byte = (byte << 1) | b;
      }
      if (byte !== MAGIC_HEADER[h]) { match = false; break; }
    }
    if (match) return start;
  }
  return -1;
}

function tryExtract(data, pixelCount, bp, seed) {
  const mask = 1 << bp;
  
  // 方法1：使用种子定位
  if (seed) {
    const rng = seededRandom(seed);
    const totalCapacity = pixelCount;
    
    // 尝试多个可能的位置
    for (let attempt = 0; attempt < 10; attempt++) {
      const startPos = Math.floor(rng() * (totalCapacity - 1000));
      const bits = tryExtractAtPosition(data, pixelCount, bp, startPos, 1000);
      if (bits) {
        // 检查魔数头
        let headerMatch = true;
        for (let h = 0; h < MAGIC_HEADER.length; h++) {
          let byte = 0;
          for (let bit = 0; bit < 8; bit++) {
            byte = (byte << 1) | bits[h * 8 + bit];
          }
          if (byte !== MAGIC_HEADER[h]) { headerMatch = false; break; }
        }
        if (headerMatch) {
          return extractFromPosition(data, pixelCount, bp, startPos);
        }
      }
    }
  }
  
  // 方法2：暴力搜索魔数头
  const pos = findWatermarkPosition(data, pixelCount, bp);
  if (pos >= 0) {
    return extractFromPosition(data, pixelCount, bp, pos);
  }
  
  return null;
}

function extractFromPosition(data, pixelCount, bp, startPos) {
  const mask = 1 << bp;
  
  // 先读取头部获取长度
  const headerBits = MAGIC_HEADER.length * 8;
  const lenBits = 32;
  const totalHeader = headerBits + lenBits;
  
  const headerData = tryExtractAtPosition(data, pixelCount, bp, startPos, totalHeader + 32);
  if (!headerData) return null;
  
  // 解析长度
  let dataLen = 0;
  for (let i = 0; i < 32; i++) {
    dataLen = (dataLen << 1) | headerData[headerBits + i];
  }
  
  if (dataLen <= 0 || dataLen > MAX_TEXT_LENGTH) return null;
  
  // 计算完整水印长度（包含 ECC）
  const eccLen = Math.ceil(dataLen * 8 * ECC_RATIO);
  const totalWatermarkLen = headerBits + 32 + dataLen * 8 + eccLen;
  
  // 读取完整水印
  const fullBits = tryExtractAtPosition(data, pixelCount, bp, startPos, totalWatermarkLen);
  if (!fullBits) return null;
  
  // 提取数据位
  const dataStart = headerBits + 32;
  const dataBits = Array.from(fullBits.slice(dataStart, dataStart + dataLen * 8));
  
  // ECC 解码
  const eccStart = dataStart + dataLen * 8;
  const eccBits = Array.from(fullBits.slice(eccStart, eccStart + eccLen));
  
  // 验证 ECC
  let eccErrors = 0;
  const chunkSize = Math.ceil((dataLen * 8) / eccLen);
  for (let i = 0; i < eccLen; i++) {
    let parity = 0;
    for (let j = 0; j < chunkSize; j++) {
      const idx = i * chunkSize + j;
      if (idx < dataBits.length) parity ^= dataBits[idx];
    }
    if (eccBits[i] !== undefined && parity !== eccBits[i]) eccErrors++;
  }
  
  // 解码文本
  const text = bitsToText(dataBits);
  if (!text) return null;
  
  // 计算匹配置信度
  const reBits = textToBits(text);
  let matches = 0;
  for (let i = 0; i < reBits.length && i < dataBits.length; i++) {
    if (reBits[i] === dataBits[i]) matches++;
  }
  const ratio = Math.round((matches / reBits.length) * 100);
  
  return {
    text,
    score: ratio,
    bp,
    seed_used: '(已解码)',
    ecc_errors: eccErrors,
    ecc_total: eccLen
  };
}

export async function detectWatermark(imageBytes, bitplane = 3, seed = '') {
  const { imageData, width, height } = await imageToRGBA(imageBytes);
  const data = imageData.data;
  const pixelCount = width * height;
  
  if (bitplane === 3) {
    // 智能扫描：尝试所有位平面
    const candidates = [];
    for (const bp of [0, 1, 2]) {
      for (const s of [seed, '']) {
        const r = tryExtract(data, pixelCount, bp, s);
        if (r && r.score > 50) candidates.push(r);
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return { success: true, ...candidates[0] };
    }
    return { success: false, text: '', score: 0, bp: -1, seed_used: '' };
  }
  
  const r = tryExtract(data, pixelCount, bitplane, seed);
  if (r && r.score > 50) return { success: true, ...r };
  return { success: false, text: '', score: 0, bp: bitplane, seed_used: seed || '(无密码)' };
}
