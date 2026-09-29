/* ============================================================
 * HX 图片工具箱 —— 纯前端本地图片处理
 * 功能：压缩 / 格式导出 / 裁剪 / 缩放 / 旋转翻转 / 亮度 / 对比度 / 锐化 / 文字水印
 * 所有处理均在浏览器本地完成，不上传任何数据。
 *
 * 处理管线（顺序固定）：
 *   原图 → 旋转/翻转/微调角度（几何画布，带缓存）
 *       → 裁剪 → 缩放（同一次 drawImage 完成，只重采样一次）
 *       → 亮度/对比度（ctx.filter）
 *       → 锐化（3x3 卷积，按强度混合）
 *       → 文字水印 → 编码导出
 * ============================================================ */
'use strict';

/* ================= 基础工具 ================= */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtSize = (bytes) => {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
};
const debounce = (fn, ms) => {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const canvasToBlob = (canvas, mime, quality) => new Promise((resolve) => {
  if (quality === undefined) canvas.toBlob(resolve, mime);
  else canvas.toBlob(resolve, mime, quality);
});

/* ctx.filter 兼容性检测（老 Safari 不支持时走像素级回退） */
const CAN_FILTER = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.filter = 'brightness(50%)';
  return ctx.filter === 'brightness(50%)';
})();

/* ================= 常量与全局状态 ================= */
const PREVIEW_MAX = 1400;   // 预览画布最长边（像素），控制预览渲染开销
const MIN_CROP = 8;         // 裁剪框最小边（原图像素）

let uid = 0;
const IMAGES = [];          // { id, name, baseName, origSize, url, img, state }
let activeId = null;
let geoCache = null;        // { id, sig, canvas } 几何变换结果缓存（仅当前图）
let cropMode = false;       // 是否处于裁剪编辑模式
let cropSnapshot = null;    // 进入裁剪模式前的裁剪状态（用于取消）
let lastEstimate = null;    // 最近一次预估的输出字节数
let estimateToken = 0;      // 预估任务令牌，防止过期结果覆盖
let busy = false;           // 目标压缩等长任务进行中

const defaultState = () => ({
  rotate90: 0,          // 0-3，四分之一圈数（1 = 顺时针 90°）
  flipH: false,
  flipV: false,
  angle: 0,             // 微调角度 -45 ~ 45
  crop: null,           // { x, y, w, h }，基于旋转/翻转后的原图坐标
  scaleMode: 'percent',
  scalePercent: 100,
  scaleW: 0,
  scaleH: 0,
  lockRatio: true,
  brightness: 100,      // 100 = 原样
  contrast: 100,
  sharpen: 0,           // 0-100
  wm: {
    enabled: false,
    text: '水印文字',
    font: 'sans',
    bold: true,
    sizePct: 5,         // 字号 = 图片宽度 × sizePct%
    color: '#ffffff',
    opacity: 60,
    angle: 0,
    pos: 'br',          // 九宫格：tl tc tr cl cc cr bl bc br
    margin: 4,          // 边距 = 图片宽度 × margin%
    tile: false,
    tileGap: 160,       // 平铺间距 = 字号 × tileGap%
  },
});

const FONT_STACKS = {
  sans: "'Microsoft YaHei', 'PingFang SC', 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', 'SimSun', serif",
  mono: "Consolas, 'Courier New', monospace",
  kai: "'KaiTi', 'STKaiti', 'DFKai-SB', serif",
};

const EXT_OF = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

const getActive = () => IMAGES.find((i) => i.id === activeId) || null;

/* ================= 几何变换 ================= */
const geoSig = (st) => [st.rotate90, st.flipH ? 1 : 0, st.flipV ? 1 : 0, st.angle].join('|');

/* 计算“旋转/翻转/微调角度”之后画布的完整尺寸（scale = 1） */
function geoDims(item, st) {
  const w = item.img.naturalWidth, h = item.img.naturalHeight;
  const bw = st.rotate90 % 2 === 0 ? w : h;
  const bh = st.rotate90 % 2 === 0 ? h : w;
  const rad = st.angle * Math.PI / 180;
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  return {
    w: Math.max(1, Math.round(bw * c + bh * s)),
    h: Math.max(1, Math.round(bh * c + bw * s)),
  };
}

/* 生成几何变换后的完整画布（全分辨率，按几何签名缓存） */
function getGeoCanvas(item) {
  const st = item.state;
  const sig = geoSig(st);
  if (geoCache && geoCache.id === item.id && geoCache.sig === sig) return geoCache.canvas;

  const w = item.img.naturalWidth, h = item.img.naturalHeight;
  const { w: ow, h: oh } = geoDims(item, st);
  const c = document.createElement('canvas');
  c.width = ow; c.height = oh;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  /* 变换顺序（对绘制内容而言）：翻转 → 四分之一旋转 → 微调角度 → 平移居中 */
  ctx.translate(ow / 2, oh / 2);
  ctx.rotate(st.angle * Math.PI / 180);
  ctx.rotate(st.rotate90 * Math.PI / 2);
  ctx.scale(st.flipH ? -1 : 1, st.flipV ? -1 : 1);
  ctx.drawImage(item.img, -w / 2, -h / 2, w, h);

  geoCache = { id: item.id, sig, canvas: c };
  return c;
}

/* 计算最终输出尺寸（考虑裁剪与缩放） */
function targetOutput(item) {
  const st = item.state;
  const geo = geoDims(item, st);
  const crop = st.crop && st.crop.w >= MIN_CROP && st.crop.h >= MIN_CROP
    ? st.crop
    : { x: 0, y: 0, w: geo.w, h: geo.h };
  let tw, th;
  if (st.scaleMode === 'custom' && st.scaleW > 0 && st.scaleH > 0) {
    tw = Math.round(st.scaleW);
    th = Math.round(st.scaleH);
  } else {
    const k = clamp(st.scalePercent, 5, 200) / 100;
    tw = Math.max(1, Math.round(crop.w * k));
    th = Math.max(1, Math.round(crop.h * k));
  }
  return { crop, tw, th };
}

/* ================= 核心渲染管线 =================
 * 将几何画布的 crop 区域绘制为 tw × th 的画布（支持非等比拉伸），
 * 并依次应用亮度/对比度、锐化、水印。
 */
function renderPipeline(item, tw, th) {
  const st = item.state;
  const { crop } = targetOutput(item);
  tw = Math.max(1, Math.round(tw));
  th = Math.max(1, Math.round(th));

  const geoC = getGeoCanvas(item);
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (CAN_FILTER) {
    ctx.filter = `brightness(${st.brightness}%) contrast(${st.contrast}%)`;
    ctx.drawImage(geoC, crop.x, crop.y, crop.w, crop.h, 0, 0, tw, th);
    ctx.filter = 'none';
  } else {
    ctx.drawImage(geoC, crop.x, crop.y, crop.w, crop.h, 0, 0, tw, th);
    if (st.brightness !== 100 || st.contrast !== 100) {
      applyBrightnessContrast(ctx, tw, th, st.brightness / 100, st.contrast / 100);
    }
  }

  if (st.sharpen > 0) applySharpen(ctx, tw, th, st.sharpen / 100);
  if (st.wm.enabled && String(st.wm.text || '').trim()) drawWatermark(ctx, tw, th, st.wm);
  return c;
}

/* ctx.filter 不可用时的像素级亮度/对比度回退 */
function applyBrightnessContrast(ctx, w, h, b, c) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = i * b;                       // 亮度
    v = (v - 128) * c + 128;             // 对比度
    lut[i] = v;
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
}

/* 3x3 锐化卷积：out = mix(原图, 卷积结果, amount)，边缘像素保持原样 */
function applySharpen(ctx, w, h, amount) {
  if (w < 3 || h < 3) return;
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data, d = out.data;
  const row4 = w * 4;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = (row + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const p = i + ch;
        const conv = 5 * s[p] - s[p - 4] - s[p + 4] - s[p - row4] - s[p + row4];
        d[p] = s[p] + amount * (conv - s[p]);
      }
      d[i + 3] = s[i + 3];
    }
  }
  /* 未处理的边缘一圈：复制原图 */
  const copyLine = (idxFrom, idxTo, len) => d.copyWithin(idxTo, idxFrom, idxFrom + len);
  copyLine(0, 0, row4);                                    // 顶行
  copyLine((h - 1) * row4, (h - 1) * row4, row4);          // 底行
  for (let y = 1; y < h - 1; y++) {
    const base = y * row4;
    d[base] = s[base]; d[base + 1] = s[base + 1]; d[base + 2] = s[base + 2]; d[base + 3] = s[base + 3];
    const e = base + row4 - 4;
    d[e] = s[e]; d[e + 1] = s[e + 1]; d[e + 2] = s[e + 2]; d[e + 3] = s[e + 3];
  }
  ctx.putImageData(out, 0, 0);
}

/* ================= 水印 ================= */
function drawWatermark(ctx, w, h, wm) {
  const size = Math.max(8, wm.sizePct / 100 * w);
  ctx.save();
  ctx.font = `${wm.bold ? 'bold ' : ''}${size}px ${FONT_STACKS[wm.font] || FONT_STACKS.sans}`;
  ctx.fillStyle = wm.color;
  ctx.globalAlpha = clamp(wm.opacity, 5, 100) / 100;
  ctx.textBaseline = 'middle';
  const rad = wm.angle * Math.PI / 180;

  if (wm.tile) {
    const gap = wm.tileGap / 100 * size;
    const stepX = ctx.measureText(wm.text).width + gap;
    const stepY = size * 2 + gap;
    let row = 0;
    for (let y = -h * 0.25; y < h * 1.25; y += stepY, row++) {
      const off = (row % 2) * stepX / 2;
      for (let x = -w * 0.25 - off; x < w * 1.25; x += stepX) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rad);
        ctx.fillText(wm.text, 0, 0);
        ctx.restore();
      }
    }
  } else {
    const m = wm.margin / 100 * w;
    const tw = ctx.measureText(wm.text).width;
    let x, y, align;
    switch (wm.pos[0]) {           // 水平位置
      case 'l': x = m; align = 'left'; break;
      case 'c': x = w / 2; align = 'center'; break;
      default:  x = w - m; align = 'right'; break;
    }
    switch (wm.pos[1]) {           // 垂直位置
      case 't': y = clamp(m + size / 2, 0, h); break;
      case 'c': y = h / 2; break;
      default:  y = clamp(h - m - size / 2, 0, h); break;
    }
    ctx.translate(x, y);
    ctx.rotate(rad);
    ctx.textAlign = align;
    ctx.fillText(wm.text, 0, 0);
    /* 超出边界的提示性描边不需要，保持干净 */
    void tw;
  }
  ctx.restore();
}

/* ================= 预览渲染 ================= */
let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderPreview(); });
}

function renderPreview() {
  const item = getActive();
  if (!item) return;
  if (cropMode) { renderCropPreview(); return; }

  const { tw, th } = targetOutput(item);
  const geo = geoDims(item, item.state);
  const p = Math.min(1, PREVIEW_MAX / Math.max(geo.w, geo.h));
  const c = renderPipeline(item, Math.max(1, Math.round(tw * p)), Math.max(1, Math.round(th * p)));

  const cv = $('previewCanvas');
  cv.width = c.width; cv.height = c.height;
  cv.getContext('2d').drawImage(c, 0, 0);
  cv.hidden = false;
  $('cropCanvas').hidden = true;
  $('cropOverlay').hidden = true;

  updateStatus(item);
  scheduleEstimate();
}

function updateStatus(item) {
  if (!item) { $('stName').textContent = '—'; $('stMeta').textContent = ''; return; }
  const { tw, th } = targetOutput(item);
  $('stName').textContent = item.name;
  $('outDims').textContent = `${tw} × ${th} px`;
  $('stMeta').textContent =
    `原始 ${item.img.naturalWidth}×${item.img.naturalHeight} · ${fmtSize(item.origSize)}` +
    ` → 输出 ${tw}×${th}` +
    (lastEstimate != null ? ` · 预计 ${fmtSize(lastEstimate)}` : '');
}

/* ================= 裁剪模式 ================= */
function buildCropOverlay() {
  const ov = $('cropOverlay');
  ov.innerHTML = '';
  const rect = document.createElement('div');
  rect.id = 'cropRect';
  ['v1', 'v2', 'h1', 'h2'].forEach((cls) => {
    const d = document.createElement('div');
    d.className = 'third ' + cls;
    rect.appendChild(d);
  });
  const info = document.createElement('div');
  info.id = 'cropInfo';
  rect.appendChild(info);
  ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((h) => {
    const d = document.createElement('div');
    d.className = 'handle h-' + h;
    d.dataset.h = h;
    rect.appendChild(d);
  });
  ov.appendChild(rect);
}

/* 覆盖层贴齐裁剪画布的显示区域 */
function positionCropOverlay() {
  const ov = $('cropOverlay');
  const cv = $('cropCanvas');
  const wrap = $('canvasWrap');
  if (ov.hidden || cv.hidden) return;
  const left = cv.offsetLeft, top = cv.offsetTop;
  ov.style.left = left + 'px';
  ov.style.top = top + 'px';
  ov.style.width = cv.offsetWidth + 'px';
  ov.style.height = cv.offsetHeight + 'px';
  void wrap;
}

function renderCropPreview() {
  const item = getActive();
  if (!item) return;
  const st = item.state;
  const geo = geoDims(item, st);
  const p = Math.min(1, PREVIEW_MAX / Math.max(geo.w, geo.h));
  const geoC = getGeoCanvas(item);

  const cv = $('cropCanvas');
  cv.width = Math.max(1, Math.round(geo.w * p));
  cv.height = Math.max(1, Math.round(geo.h * p));
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(geoC, 0, 0, cv.width, cv.height);

  if (!st.crop || st.crop.w < MIN_CROP || st.crop.h < MIN_CROP) {
    const ratio = parseFloat($('cropAspect').value) || 0;
    let cw = geo.w * 0.8, ch = geo.h * 0.8;
    if (ratio > 0) {
      if (cw / ch > ratio) cw = ch * ratio; else ch = cw / ratio;
    }
    st.crop = { x: (geo.w - cw) / 2, y: (geo.h - ch) / 2, w: cw, h: ch };
  }

  $('previewCanvas').hidden = true;
  cv.hidden = false;
  $('cropOverlay').hidden = false;
  positionCropOverlay();
  updateCropVisuals();
}

/* geo 坐标 → 覆盖层显示像素 的比例 */
function cropDisplayScale() {
  const cv = $('cropCanvas');
  const item = getActive();
  if (!item || !cv.width) return 1;
  const geo = geoDims(item, item.state);
  return cv.offsetWidth / geo.w;
}

function updateCropVisuals() {
  const item = getActive();
  if (!item || !item.state.crop) return;
  const k = cropDisplayScale();
  const c = item.state.crop;
  const rect = $('cropRect');
  rect.style.left = (c.x * k) + 'px';
  rect.style.top = (c.y * k) + 'px';
  rect.style.width = Math.max(2, c.w * k) + 'px';
  rect.style.height = Math.max(2, c.h * k) + 'px';
  $('cropInfo').textContent = `${Math.round(c.w)} × ${Math.round(c.h)} px`;
  updateCropStateLabel(item);
}

function updateCropStateLabel(item) {
  const c = item.state.crop;
  const geo = geoDims(item, item.state);
  const isFull = !c || (c.x < 1 && c.y < 1 && c.w > geo.w - 2 && c.h > geo.h - 2);
  $('cropState').textContent = isFull
    ? '未裁剪（使用完整画面）'
    : `已裁剪：起点 (${Math.round(c.x)}, ${Math.round(c.y)})，尺寸 ${Math.round(c.w)} × ${Math.round(c.h)} px`;
}

function enterCropMode() {
  const item = getActive();
  if (!item) return;
  cropSnapshot = item.state.crop ? { ...item.state.crop } : null;
  cropMode = true;
  document.body.classList.add('crop-mode');
  $('cropEnter').hidden = true;
  $('cropActions').hidden = false;
  $('dropHint').hidden = true;
  $('canvasWrap').hidden = false;
  renderCropPreview();
}

function exitCropMode(apply) {
  const item = getActive();
  cropMode = false;
  document.body.classList.remove('crop-mode');
  $('cropEnter').hidden = false;
  $('cropActions').hidden = true;
  $('cropOverlay').hidden = true;
  $('cropCanvas').hidden = true;
  if (!apply && item) item.state.crop = cropSnapshot;
  if (item) { syncControls(); renderPreview(); }
  else updateEmptyState();
}

/* 几何参数变化时，旧裁剪坐标失效，直接清除 */
function resetCropOnGeometryChange() {
  const item = getActive();
  if (!item) return;
  item.state.crop = null;
  if (cropMode) exitCropMode(false);
}

/* ---- 裁剪框拖拽 ---- */
let cropDrag = null;

function cropGeoPoint(e) {
  const ov = $('cropOverlay');
  const r = ov.getBoundingClientRect();
  const k = cropDisplayScale();
  return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
}

function bindCropOverlayEvents() {
  const ov = $('cropOverlay');

  ov.addEventListener('pointerdown', (e) => {
    const item = getActive();
    if (!item || !cropMode) return;
    e.preventDefault();
    ov.setPointerCapture(e.pointerId);
    const g = cropGeoPoint(e);
    const handle = e.target.dataset ? e.target.dataset.h : null;
    let mode = handle;
    if (!mode) {
      const c = item.state.crop;
      const inside = c && g.x >= c.x && g.x <= c.x + c.w && g.y >= c.y && g.y <= c.y + c.h;
      mode = inside ? 'move' : 'new';
    }
    cropDrag = { mode, sx: g.x, sy: g.y, start: item.state.crop ? { ...item.state.crop } : null };
    if (mode === 'new') item.state.crop = { x: g.x, y: g.y, w: 0, h: 0 };
  });

  ov.addEventListener('pointermove', (e) => {
    const item = getActive();
    if (!item || !cropDrag) return;
    const g = cropGeoPoint(e);
    const geo = geoDims(item, item.state);
    const st = item.state;
    const d = cropDrag;
    let left, right, top, bottom;

    if (d.mode === 'move' && d.start) {
      const nx = clamp(d.start.x + (g.x - d.sx), 0, geo.w - d.start.w);
      const ny = clamp(d.start.y + (g.y - d.sy), 0, geo.h - d.start.h);
      st.crop = { x: nx, y: ny, w: d.start.w, h: d.start.h };
      updateCropVisuals();
      return;
    }

    if (d.mode === 'new') {
      left = Math.min(d.sx, g.x); right = Math.max(d.sx, g.x);
      top = Math.min(d.sy, g.y); bottom = Math.max(d.sy, g.y);
    } else {
      const s = d.start;
      left = s.x; right = s.x + s.w; top = s.y; bottom = s.y + s.h;
      if (d.mode.includes('w')) left = g.x;
      if (d.mode.includes('e')) right = g.x;
      if (d.mode.includes('n')) top = g.y;
      if (d.mode.includes('s')) bottom = g.y;
      if (left > right) [left, right] = [right, left];
      if (top > bottom) [top, bottom] = [bottom, top];
    }

    /* 夹在画布范围内 */
    left = clamp(left, 0, geo.w); right = clamp(right, 0, geo.w);
    top = clamp(top, 0, geo.h); bottom = clamp(bottom, 0, geo.h);

    const ratio = parseFloat($('cropAspect').value) || 0;
    if (ratio > 0 && right - left >= 1 && bottom - top >= 1) {
      ({ left, right, top, bottom } = applyCropAspect(left, right, top, bottom, d.mode, ratio, geo));
    }

    st.crop = {
      x: left, y: top,
      w: Math.max(0, right - left),
      h: Math.max(0, bottom - top),
    };
    updateCropVisuals();
  });

  const finish = () => {
    const item = getActive();
    if (item && cropDrag) {
      const c = item.state.crop;
      /* 拖出的框太小则视为误触，恢复进入模式前/上一次的有效状态 */
      if (cropDrag.mode === 'new' && (c.w < MIN_CROP || c.h < MIN_CROP)) {
        item.state.crop = cropDrag.start || { x: 0, y: 0, w: geoDims(item, item.state).w, h: geoDims(item, item.state).h };
      }
      updateCropVisuals();
    }
    cropDrag = null;
  };
  ov.addEventListener('pointerup', finish);
  ov.addEventListener('pointercancel', finish);
}

/* 按锁定比例调整裁剪框（角点以对角为锚，边以对边为锚并居中另一轴） */
function applyCropAspect(left, right, top, bottom, mode, ratio, geo) {
  let w = right - left, h = bottom - top;
  if (w < 1 || h < 1) return { left, right, top, bottom };

  if (mode === 'n' || mode === 's') {
    const cx = (left + right) / 2;
    w = Math.min(h * ratio, geo.w);
    h = w / ratio;
    left = cx - w / 2; right = cx + w / 2;
    if (mode === 'n') bottom = top + h; else top = bottom - h;
  } else if (mode === 'e' || mode === 'w') {
    const cy = (top + bottom) / 2;
    h = Math.min(w / ratio, geo.h);
    w = h * ratio;
    top = cy - h / 2; bottom = cy + h / 2;
    if (mode === 'e') left = right - w; else right = left + w;
  } else {
    if (w / h > ratio) {
      w = h * ratio;
      if (mode.includes('w')) left = right - w; else right = left + w;
    } else {
      h = w / ratio;
      if (mode.includes('n')) top = bottom - h; else bottom = top + h;
    }
  }

  /* 越界则整体缩回画布内 */
  if (left < 0) { const dw = -left; left = 0; right = Math.max(MIN_CROP, right - dw); }
  if (top < 0) { const dh = -top; top = 0; bottom = Math.max(MIN_CROP, bottom - dh); }
  if (right > geo.w) right = geo.w;
  if (bottom > geo.h) bottom = geo.h;
  return { left, right, top, bottom };
}

/* ================= 导出 / 压缩 ================= */
function getExportOpts() {
  const fmt = $('fmt').value;
  return {
    fmt,
    quality: clamp(parseInt($('quality').value, 10) || 80, 5, 100),
    bg: $('jpegBg').value,
    suffix: $('suffix').value.trim(),
  };
}

function buildExportCanvas(item) {
  const { tw, th } = targetOutput(item);
  return renderPipeline(item, tw, th);
}

/* JPEG 不支持透明，导出前铺底色 */
function flatten(canvas, bg) {
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

async function encodeItem(item, qualityOverride) {
  const o = getExportOpts();
  const q = qualityOverride === undefined ? o.quality : clamp(qualityOverride, 5, 100);
  let canvas = buildExportCanvas(item);
  if (o.fmt === 'jpeg') canvas = flatten(canvas, o.bg);
  const mime = o.fmt === 'jpeg' ? 'image/jpeg' : o.fmt === 'webp' ? 'image/webp' : 'image/png';
  const blob = await canvasToBlob(canvas, mime, o.fmt === 'png' ? undefined : q / 100);
  const actualFmt = EXT_OF[blob.type] === 'webp' || EXT_OF[blob.type] === 'jpg' ? o.fmt : EXT_OF[blob.type];
  return { blob, fmt: actualFmt, opts: o };
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function outFilename(item, fmt, suffix) {
  const ext = EXT_OF[fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png'];
  return `${item.baseName}${suffix || '-edited'}.${ext}`;
}

async function exportItem(item) {
  const { blob, fmt, opts } = await encodeItem(item);
  downloadBlob(blob, outFilename(item, fmt, opts.suffix));
  return blob;
}

async function exportCurrent() {
  const item = getActive();
  if (!item || busy) return;
  try {
    const { blob, fmt, opts } = await encodeItem(item);
    const name = outFilename(item, fmt, opts.suffix);
    downloadBlob(blob, name);
    toast(`已导出：${name}（${fmtSize(blob.size)}）`);
    lastEstimate = blob.size;
    updateEstimateUI(item);
  } catch (err) {
    console.error(err);
    toast('导出失败：' + err.message);
  }
}

async function exportAll() {
  if (!IMAGES.length || busy) return;
  busy = true;
  toast(`开始导出 ${IMAGES.length} 张图片…`);
  try {
    for (const item of IMAGES) {
      await exportItem(item);
      await delay(350);
    }
    toast('全部导出完成');
  } catch (err) {
    console.error(err);
    toast('导出失败：' + err.message);
  } finally {
    busy = false;
  }
}

/* —— 智能压缩到目标大小：二分搜索质量（仅 JPEG / WebP） —— */
async function compressToTarget() {
  const item = getActive();
  if (!item || busy) return;
  const fmt = $('fmt').value;
  if (fmt === 'png') { toast('PNG 为无损格式，请先切换到 JPEG 或 WebP'); return; }
  const kb = parseInt($('targetKB').value, 10);
  if (!(kb > 0)) { toast('请先输入目标大小（KB）'); return; }

  busy = true;
  toast('正在计算合适的质量值…');
  try {
    /* 二分搜索“不超过目标大小的最高质量” */
    let lo = 5, hi = 100, bestBlob = null, bestQ = null;
    for (let i = 0; i < 7 && hi - lo > 1; i++) {
      const q = Math.round((lo + hi) / 2);
      const { blob } = await encodeItem(item, q);
      if (blob.size <= kb * 1024) { bestBlob = blob; bestQ = q; lo = q; }
      else hi = q;
    }
    if (!bestBlob) { const r = await encodeItem(item, 5); bestBlob = r.blob; bestQ = 5; }

    $('quality').value = bestQ;
    $('qualityVal').textContent = bestQ;
    lastEstimate = bestBlob.size;
    updateEstimateUI(item);
    const ok = bestBlob.size <= kb * 1024;
    toast(ok
      ? `已将质量设为 ${bestQ}，预计输出 ${fmtSize(bestBlob.size)}（目标 ${kb} KB）`
      : `最低质量仍为 ${fmtSize(bestBlob.size)}，已无法压到 ${kb} KB，可尝试先缩小尺寸`);
  } catch (err) {
    console.error(err);
    toast('压缩失败：' + err.message);
  } finally {
    busy = false;
  }
}

/* —— 输出大小预估（防抖） —— */
const scheduleEstimate = debounce(estimateSize, 600);
async function estimateSize() {
  const item = getActive();
  if (!item) return;
  const token = ++estimateToken;
  try {
    const { blob } = await encodeItem(item);
    if (token !== estimateToken) return;
    lastEstimate = blob.size;
    updateEstimateUI(item);
  } catch (err) {
    console.warn('预估失败', err);
  }
}

function updateEstimateUI(item) {
  if (!item) return;
  const est = lastEstimate;
  const el = $('estInfo');
  if (est == null) { el.textContent = '预计输出大小：—'; }
  else {
    const diff = item.origSize > 0 ? Math.round((1 - est / item.origSize) * 100) : null;
    const deltaTxt = diff == null ? '' : diff > 0
      ? `（原 ${fmtSize(item.origSize)}，减小 ${diff}%）`
      : diff < 0 ? `（原 ${fmtSize(item.origSize)}，增大 ${-diff}%）`
      : `（与原始大小相同）`;
    el.textContent = `预计输出大小：${fmtSize(est)} ${deltaTxt}`;
  }
  updateStatus(item);
}

/* ================= 图片载入 / 队列 ================= */
async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) { toast('未识别到图片文件'); return; }
  let added = 0, firstId = null;
  for (const f of list) {
    try {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.decoding = 'async';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('无法读取尺寸');
      const item = {
        id: ++uid,
        name: f.name,
        baseName: f.name.replace(/\.[^.]+$/, '') || 'image',
        origSize: f.size,
        url, img,
        state: defaultState(),
      };
      IMAGES.push(item);
      if (firstId === null) firstId = item.id;
      added++;
    } catch (err) {
      console.warn('载入失败', f.name, err);
      toast(`「${f.name}」载入失败`);
    }
  }
  if (!added) return;
  refreshQueue();
  if (!activeId) setActive(firstId);
  else updateEmptyState();
  toast(`已添加 ${added} 张图片`);
}

function setActive(id) {
  if (cropMode) exitCropMode(false);
  activeId = id;
  lastEstimate = null;
  refreshQueue();
  syncControls();
  updateEmptyState();
  if (getActive()) { renderPreview(); updateCropStateLabel(getActive()); }
}

function removeItem(id) {
  const idx = IMAGES.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const item = IMAGES[idx];
  URL.revokeObjectURL(item.url);
  IMAGES.splice(idx, 1);
  if (activeId === id) {
    if (cropMode) { cropMode = false; document.body.classList.remove('crop-mode'); $('cropEnter').hidden = false; $('cropActions').hidden = true; }
    activeId = IMAGES.length ? IMAGES[Math.min(idx, IMAGES.length - 1)].id : null;
    lastEstimate = null;
    syncControls();
  }
  refreshQueue();
  updateEmptyState();
  if (getActive()) renderPreview();
}

function refreshQueue() {
  const list = $('queueList');
  list.innerHTML = '';
  $('queueCount').textContent = IMAGES.length ? `(${IMAGES.length})` : '';
  for (const item of IMAGES) {
    const div = document.createElement('div');
    div.className = 'qitem' + (item.id === activeId ? ' active' : '');
    div.dataset.id = item.id;
    div.title = item.name;
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'qmeta';
    const name = document.createElement('div');
    name.className = 'qname';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'qsub';
    sub.textContent = `${item.img.naturalWidth}×${item.img.naturalHeight} · ${fmtSize(item.origSize)}`;
    meta.append(name, sub);
    const del = document.createElement('button');
    del.className = 'qdel';
    del.dataset.del = item.id;
    del.textContent = '×';
    del.title = '移除';
    div.append(img, meta, del);
    list.appendChild(div);
  }
}

function updateEmptyState() {
  const has = !!getActive();
  $('dropHint').hidden = has || cropMode;
  $('canvasWrap').hidden = !has && !cropMode;
  $('panel').classList.toggle('disabled', !has);
  $('btnExport').disabled = !has;
  $('btnExportAll').disabled = IMAGES.length === 0;
  if (!has) {
    $('stName').textContent = '—';
    $('stMeta').textContent = '';
    $('previewCanvas').hidden = true;
  }
}

/* ================= 控制面板同步与绑定 ================= */
function syncControls() {
  const item = getActive();
  updateEmptyState();
  if (!item) return;
  const st = item.state;

  $('angle').value = st.angle;
  $('angleVal').textContent = st.angle + '°';

  $('scaleMode').value = st.scaleMode;
  $('rowPercent').hidden = st.scaleMode !== 'percent';
  $('rowWH').hidden = st.scaleMode !== 'custom';
  $('scalePercent').value = st.scalePercent;
  $('scalePercentVal').textContent = st.scalePercent + '%';
  if (st.scaleMode === 'custom' && (!st.scaleW || !st.scaleH)) {
    const { tw, th } = targetOutput(item);
    st.scaleW = tw; st.scaleH = th;
  }
  $('scaleW').value = st.scaleW || '';
  $('scaleH').value = st.scaleH || '';
  $('lockRatio').checked = st.lockRatio;

  $('brightness').value = st.brightness;
  $('brightnessVal').textContent = st.brightness;
  $('contrast').value = st.contrast;
  $('contrastVal').textContent = st.contrast;
  $('sharpen').value = st.sharpen;
  $('sharpenVal').textContent = st.sharpen;

  const wm = st.wm;
  $('wmEnabled').checked = wm.enabled;
  $('wmBox').classList.toggle('off', !wm.enabled);
  $('wmText').value = wm.text;
  $('wmFont').value = wm.font;
  $('wmBold').checked = wm.bold;
  $('wmSize').value = wm.sizePct;
  $('wmSizeVal').textContent = wm.sizePct + '%';
  $('wmColor').value = wm.color;
  $('wmOpacity').value = wm.opacity;
  $('wmOpacityVal').textContent = wm.opacity + '%';
  $('wmAngle').value = wm.angle;
  $('wmAngleVal').textContent = wm.angle + '°';
  $('wmPos').value = wm.pos;
  $('wmMargin').value = wm.margin;
  $('wmMarginVal').textContent = wm.margin + '%';
  $('wmTile').checked = wm.tile;
  $('wmTileGap').disabled = !wm.tile;
  $('wmTileGap').value = wm.tileGap;
  $('wmTileGapVal').textContent = wm.tileGap + '%';

  updateCropStateLabel(item);
  updateQualityRow();
  updateEstimateUI(item);
}

function updateQualityRow() {
  const fmt = $('fmt').value;
  $('qualityRow').hidden = fmt === 'png';
  $('jpegBgRow').hidden = fmt !== 'jpeg';
  $('btnTarget').disabled = fmt === 'png';
  const q = parseInt($('quality').value, 10) || 80;
  $('qualityVal').textContent = q;
}

/* 通用滑块绑定 */
function bindRange(id, setter, format) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value);
    setter(v);
    if (format) $(id + 'Val').textContent = format(v);
    onEdit();
  });
}

function onEdit() {
  const item = getActive();
  if (!item) return;
  renderPreview();
}

function bindAllControls() {
  /* —— 顶栏 —— */
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('btnDemo').addEventListener('click', makeDemoImage);
  $('btnExport').addEventListener('click', exportCurrent);
  $('btnExportAll').addEventListener('click', exportAll);

  /* —— 图片队列：点击切换，× 移除 —— */
  $('queueList').addEventListener('click', (e) => {
    const del = e.target.closest('.qdel');
    if (del) { removeItem(parseInt(del.dataset.del, 10)); return; }
    const card = e.target.closest('.qitem');
    if (card) {
      const id = parseInt(card.dataset.id, 10);
      if (id !== activeId) setActive(id);
    }
  });

  /* —— 几何 —— */
  $('rotL').addEventListener('click', () => { const s = getActive()?.state; if (!s) return; s.rotate90 = (s.rotate90 + 3) % 4; resetCropOnGeometryChange(); renderPreview(); });
  $('rotR').addEventListener('click', () => { const s = getActive()?.state; if (!s) return; s.rotate90 = (s.rotate90 + 1) % 4; resetCropOnGeometryChange(); renderPreview(); });
  $('flipHBtn').addEventListener('click', () => { const s = getActive()?.state; if (!s) return; s.flipH = !s.flipH; resetCropOnGeometryChange(); renderPreview(); });
  $('flipVBtn').addEventListener('click', () => { const s = getActive()?.state; if (!s) return; s.flipV = !s.flipV; resetCropOnGeometryChange(); renderPreview(); });
  bindRange('angle', (v) => { const s = getActive()?.state; if (s) { s.angle = v; resetCropOnGeometryChange(); } }, (v) => v + '°');

  /* —— 裁剪 —— */
  $('cropEnter').addEventListener('click', enterCropMode);
  $('cropApply').addEventListener('click', () => {
    const item = getActive();
    if (item && item.state.crop && (item.state.crop.w < MIN_CROP || item.state.crop.h < MIN_CROP)) {
      item.state.crop = null;
    }
    exitCropMode(true);
    toast('裁剪已应用');
  });
  $('cropCancel').addEventListener('click', () => exitCropMode(false));
  $('cropReset').addEventListener('click', () => {
    const item = getActive();
    if (!item) return;
    const geo = geoDims(item, item.state);
    item.state.crop = cropMode ? { x: 0, y: 0, w: geo.w, h: geo.h } : null;
    if (cropMode) updateCropVisuals();
    else { updateCropStateLabel(item); renderPreview(); }
  });
  $('cropAspect').addEventListener('change', () => {
    const item = getActive();
    if (!item || !cropMode || !item.state.crop) return;
    const ratio = parseFloat($('cropAspect').value) || 0;
    if (ratio > 0) {
      const geo = geoDims(item, item.state);
      const c = item.state.crop;
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      let w = Math.min(c.w, geo.w), h = w / ratio;
      if (h > geo.h) { h = geo.h; w = h * ratio; }
      item.state.crop = {
        x: clamp(cx - w / 2, 0, geo.w - w),
        y: clamp(cy - h / 2, 0, geo.h - h),
        w, h,
      };
      updateCropVisuals();
    }
  });

  /* —— 缩放 —— */
  $('scaleMode').addEventListener('change', () => {
    const s = getActive()?.state;
    if (!s) return;
    s.scaleMode = $('scaleMode').value;
    if (s.scaleMode === 'custom') {
      const item = getActive();
      const { tw, th } = targetOutput(item);
      s.scaleW = tw; s.scaleH = th;
      $('scaleW').value = tw;
      $('scaleH').value = th;
    }
    $('rowPercent').hidden = s.scaleMode !== 'percent';
    $('rowWH').hidden = s.scaleMode !== 'custom';
    renderPreview();
  });
  bindRange('scalePercent', (v) => { const s = getActive()?.state; if (s) s.scalePercent = v; }, (v) => v + '%');
  $('scaleW').addEventListener('input', () => {
    const item = getActive(); if (!item) return;
    const s = item.state;
    const v = clamp(parseInt($('scaleW').value, 10) || 1, 1, 20000);
    s.scaleW = v;
    if (s.lockRatio) {
      const { crop } = targetOutput(item);
      s.scaleH = Math.max(1, Math.round(v * crop.h / crop.w));
      $('scaleH').value = s.scaleH;
    }
    renderPreview();
  });
  $('scaleH').addEventListener('input', () => {
    const item = getActive(); if (!item) return;
    const s = item.state;
    const v = clamp(parseInt($('scaleH').value, 10) || 1, 1, 20000);
    s.scaleH = v;
    if (s.lockRatio) {
      const { crop } = targetOutput(item);
      s.scaleW = Math.max(1, Math.round(v * crop.w / crop.h));
      $('scaleW').value = s.scaleW;
    }
    renderPreview();
  });
  $('lockRatio').addEventListener('change', () => {
    const s = getActive()?.state; if (s) s.lockRatio = $('lockRatio').checked;
  });

  /* —— 亮度 / 对比度 / 锐化 —— */
  bindRange('brightness', (v) => { const s = getActive()?.state; if (s) s.brightness = v; }, (v) => String(v));
  bindRange('contrast', (v) => { const s = getActive()?.state; if (s) s.contrast = v; }, (v) => String(v));
  bindRange('sharpen', (v) => { const s = getActive()?.state; if (s) s.sharpen = v; }, (v) => String(v));

  /* —— 水印 —— */
  const wmSet = (key, cast = (v) => v) => (v) => {
    const s = getActive()?.state; if (s) s.wm[key] = cast(v);
  };
  $('wmEnabled').addEventListener('change', () => {
    const s = getActive()?.state; if (!s) return;
    s.wm.enabled = $('wmEnabled').checked;
    $('wmBox').classList.toggle('off', !s.wm.enabled);
    onEdit();
  });
  $('wmText').addEventListener('input', () => wmSet('text')($('wmText').value));
  $('wmFont').addEventListener('change', () => wmSet('font')($('wmFont').value));
  $('wmBold').addEventListener('change', () => wmSet('bold', () => $('wmBold').checked)());
  bindRange('wmSize', wmSet('sizePct'), (v) => v + '%');
  $('wmColor').addEventListener('input', () => wmSet('color')($('wmColor').value));
  bindRange('wmOpacity', wmSet('opacity'), (v) => v + '%');
  bindRange('wmAngle', wmSet('angle'), (v) => v + '°');
  $('wmPos').addEventListener('change', () => wmSet('pos')($('wmPos').value));
  bindRange('wmMargin', wmSet('margin'), (v) => v + '%');
  $('wmTile').addEventListener('change', () => {
    const s = getActive()?.state; if (!s) return;
    s.wm.tile = $('wmTile').checked;
    $('wmTileGap').disabled = !s.wm.tile;
    onEdit();
  });
  bindRange('wmTileGap', wmSet('tileGap'), (v) => v + '%');

  /* —— 导出 —— */
  $('fmt').addEventListener('change', () => { updateQualityRow(); scheduleEstimate(); });
  $('quality').addEventListener('input', () => {
    $('qualityVal').textContent = $('quality').value;
    scheduleEstimate();
  });
  $('jpegBg').addEventListener('input', scheduleEstimate);
  $('suffix').addEventListener('input', () => {});
  $('btnTarget').addEventListener('click', compressToTarget);
  $('btnResetAll').addEventListener('click', () => {
    const item = getActive(); if (!item) return;
    const keepText = item.state.wm.text;
    item.state = defaultState();
    item.state.wm.text = keepText;
    if (cropMode) exitCropMode(false);
    syncControls();
    renderPreview();
    toast('已重置当前图片的全部设置');
  });
}

/* ================= 示例图片（内置，便于快速体验） ================= */
function makeDemoImage() {
  const c = document.createElement('canvas');
  c.width = 1600; c.height = 1000;
  const g = c.getContext('2d');

  const grd = g.createLinearGradient(0, 0, 0, 1000);
  grd.addColorStop(0, '#1e3a8a');
  grd.addColorStop(0.55, '#3b82f6');
  grd.addColorStop(1, '#93c5fd');
  g.fillStyle = grd;
  g.fillRect(0, 0, 1600, 1000);

  g.fillStyle = '#fde047';
  g.beginPath(); g.arc(1310, 200, 85, 0, Math.PI * 2); g.fill();

  const mountain = (pts, color) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath(); g.fill();
  };
  mountain([[0, 1000], [260, 520], [540, 1000]], '#14532d');
  mountain([[380, 1000], [810, 420], [1270, 1000]], '#166534');
  mountain([[1020, 1000], [1390, 560], [1600, 760], [1600, 1000]], '#15803d');

  g.fillStyle = 'rgba(255,255,255,.95)';
  g.font = "bold 84px 'Segoe UI','Microsoft YaHei',sans-serif";
  g.fillText('示例图片 SAMPLE', 70, 150);
  g.font = "30px 'Segoe UI','Microsoft YaHei',sans-serif";
  g.fillStyle = 'rgba(255,255,255,.8)';
  g.fillText('1600 × 1000 · 用于体验亮度 / 对比度 / 锐化 / 水印等效果', 74, 205);

  g.strokeStyle = 'rgba(255,255,255,.45)';
  g.lineWidth = 1;
  for (let x = 0; x <= 1600; x += 80) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 1000); g.stroke();
  }
  for (let y = 0; y <= 1000; y += 80) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(1600, y); g.stroke();
  }

  c.toBlob((blob) => {
    const f = new File([blob], 'demo-sample.png', { type: 'image/png' });
    addFiles([f]);
  }, 'image/png');
}

/* ================= 拖放 / 粘贴 / 快捷键 ================= */
function bindGlobalEvents() {
  ['dragover', 'dragenter'].forEach((ev) =>
    window.addEventListener(ev, (e) => { e.preventDefault(); $('stage').classList.add('drag'); }));
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null || e.target === document.documentElement) $('stage').classList.remove('drag');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    $('stage').classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', (e) => {
    const fs = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cropMode) exitCropMode(false);
  });
  window.addEventListener('resize', () => { if (cropMode) positionCropOverlay(); });
}

/* ================= Toast ================= */
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ================= 启动 ================= */
function init() {
  buildCropOverlay();
  bindCropOverlayEvents();
  bindAllControls();
  bindGlobalEvents();
  updateEmptyState();
  updateQualityRow();
}
init();
