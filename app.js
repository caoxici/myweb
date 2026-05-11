/*
 * StegaLoom Pro — 前端应用逻辑 (CF Workers 版)
 * 部署前使用 obfuscate.py 混淆，防止源码扒取
 */

// ─── Config ───
var API_BASE = (function() {
  // Auto-detect: if on Cloudflare Pages, /api goes to Workers
  var hostname = location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:8787/api';
  return '/api';
})();

var toastTimer = null;

function $(id) { return document.getElementById(id); }
function show(id, v) { $(id).style.display = v ? '' : 'none'; }

function toast(msg, t) {
  var el = $('toast');
  if (toastTimer) clearTimeout(toastTimer);
  el.textContent = msg; el.className = 'ss show';
  toastTimer = setTimeout(function() { el.className = 'ss'; }, t || 2500);
}

// Tab
document.querySelectorAll('.tb-btn').forEach(function(b) {
  b.onclick = function() {
    document.querySelectorAll('.tb-btn').forEach(function(x) { x.className = x.className.replace(' active', '').trim(); });
    b.className = 'tb-btn active';
    document.querySelectorAll('.panel').forEach(function(p) { p.className = p.className.replace(' active', '').trim(); });
    $('panel-' + b.dataset.tab).className = 'panel active';
  };
});

function readB64(f) {
  return new Promise(function(y, n) {
    var r = new FileReader();
    r.onload = function(e) { y(e.target.result); };
    r.onerror = n; r.readAsDataURL(f);
  });
}

function setStatus(m) { $('status-bar').innerHTML = '<span>' + m + '</span>'; }

function showMsg(id, text, type) {
  var ic = { success: '&#9989;', error: '&#10060;', info: '&#8505;&#65039;' };
  $(id).innerHTML = '<div class="rc ' + type + '"><div class="rd">' + (ic[type] || '') + ' ' + text + '</div></div>';
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function fmtSize(b) {
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

// File input events
$('inp-img').onchange = function() {
  if (this.files && this.files[0]) {
    show('preview-box', false); show('pv-wm-box', false);
    show('btn-dl', false); $('result-embed').innerHTML = '';
  }
};
$('inp-det-img').onchange = function() {
  if (this.files && this.files[0]) {
    show('det-preview', false); $('result-detect').innerHTML = '';
  }
};

// ─── Embed ───
$('btn-embed').onclick = async function() {
  var files = $('inp-img').files;
  if (!files || !files[0]) return showMsg('result-embed', '请先上传一张图片', 'error');
  var text = $('inp-text').value.trim();
  if (!text) return showMsg('result-embed', '请输入水印文本内容', 'error');
  var bp = parseInt($('inp-bp').value);
  var seed = $('inp-seed').value.trim();
  var btn = this; btn.disabled = true;
  btn.innerHTML = '<span class="loading"></span> 正在处理...';
  setStatus('&#9200; 正在连接 Workers 嵌入水印...');
  try {
    var b64 = await readB64(files[0]);
    var resp = await fetch(API_BASE + '/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64, text: text, bitplane: bp, seed: seed })
    });
    var data = await resp.json();
    if (!data.success) {
      showMsg('result-embed', '处理失败: ' + (data.error || ''), 'error');
      setStatus('&#10060; 嵌入失败'); btn.disabled = false; btn.innerHTML = '&#9889; 嵌入暗水印'; return;
    }
    var wmUrl = 'data:image/png;base64,' + data.image;
    show('preview-box', true);
    var fr = new FileReader();
    fr.onload = function(e) {
      $('pv-orig').src = e.target.result;
      setTimeout(function() { $('pv-wm').src = wmUrl; show('pv-wm-box', true); show('btn-dl', true); }, 100);
    };
    fr.readAsDataURL(files[0]);
    var pw = seed ? ' &#183; 密码保护' : '';
    setStatus('&#9989; 暗水印已嵌入 &#183; "' + esc(text) + '" &#183; 位平面 ' + bp + pw);
    showMsg('result-embed', '&#9989; 嵌入成功！"' + esc(text) + '" (' + text.length + '字符) &#183; 位平面 ' + bp + ' &#183; ' + fmtSize(data.size_bytes) + pw, 'success');
  } catch (e) {
    showMsg('result-embed', '&#10060; 错误: ' + esc(e.message), 'error');
    setStatus('&#128308; 连接失败');
  }
  btn.disabled = false; btn.innerHTML = '&#9889; 嵌入暗水印';
};

// Download
document.querySelector('#btn-dl').onclick = function() {
  var img = $('pv-wm'), u = img.src;
  if (!u) return;
  fetch(u).then(function(r) { return r.blob(); }).then(function(b) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = 'watermarked.png'; a.click();
  });
};

// ─── Detect ───
$('btn-detect').onclick = async function() {
  var files = $('inp-det-img').files;
  if (!files || !files[0]) return showMsg('result-detect', '请先上传待检测图片', 'error');
  var btn = this; btn.disabled = true;
  btn.innerHTML = '<span class="loading"></span> 正在检测...';
  setStatus('&#9200; 正在 Workers 分析图片...');
  try {
    var b64 = await readB64(files[0]);
    var auto = $('auto-scan-chk').checked;
    var bp = auto ? 3 : parseInt($('inp-det-bp').value);
    var seed = $('inp-det-seed').value.trim();
    var resp = await fetch(API_BASE + '/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64, bitplane: bp, seed: seed })
    });
    var data = await resp.json();
    show('det-preview', true);
    var fr = new FileReader();
    fr.onload = function(e) { $('pv-det').src = e.target.result; };
    fr.readAsDataURL(files[0]);
    if (data.success) {
      $('result-detect').innerHTML =
        '<div class="rc s"><div class="rl">&#128270; 检测到暗水印</div><div class="rd">' +
        '<strong>水印内容：</strong>"' + esc(data.text) + '"<br>' +
        '<strong>文本长度：</strong>' + data.text.length + ' 字符 &#183; ' +
        '<strong>位平面：</strong>' + data.bitplane + '<br>' +
        '<strong>密码：</strong>' + esc(data.seed_used) + ' &#183; ' +
        '<strong>匹配度：</strong>' + data.score + '%</div></div>';
      setStatus('&#9989; 成功提取水印: "' + esc(data.text) + '"');
    } else {
      $('result-detect').innerHTML =
        '<div class="rc e"><div class="rl">&#10060; 未检测到有效水印</div><div class="rd">' +
        '自动扫描未找到可识别水印。<br>可能原因：&#9322; 图片不含水印 &#9323; 图片被压缩/裁剪</div></div>';
      setStatus('&#10060; 未检测到水印');
    }
  } catch (e) {
    showMsg('result-detect', '&#10060; 错误: ' + esc(e.message) + '<br>请检查 Workers 是否已部署', 'error');
    setStatus('&#128308; 连接失败');
  }
  btn.disabled = false; btn.innerHTML = '&#128270; 检测暗水印';
};

// ─── Particles ───
(function() {
  var c = document.getElementById('particles');
  for (var i = 30; i--;) {
    var p = document.createElement('div');
    p.className = 'p';
    p.style.left = Math.random() * 100 + '%';
    var s = 1 + Math.random() * 2.5;
    p.style.width = s + 'px'; p.style.height = s + 'px';
    p.style.animationDuration = (14 + Math.random() * 16) + 's';
    p.style.animationDelay = (Math.random() * 18) + 's';
    p.style.opacity = 0.1 + Math.random() * 0.25;
    c.appendChild(p);
  }
})();
