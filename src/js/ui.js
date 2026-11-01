// UI 装配：字体面板、转换、曲线工具、笔画列表、状态栏、快捷键。

import * as G from './geometry.js';
import * as E from './edits.js';
import * as C from './canvas.js';
import {
  state,
  subscribe,
  emit,
  undo,
  redo,
  canUndo,
  canRedo,
  clearSelection,
  clearHistory,
  pushHistory,
  setExportDir,
  onToast,
  nextShapeId,
} from './state.js';
import { invoke, isTauri } from './api.js';
import { exportShapes, exportStrokes } from './export.js';
import * as P from './projects.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// 尺寸不再提供参数面板，统一用固定排版值，后续靠拖拽选框四角缩放调整
const LAYOUT = { size: 160, leading: 200 };

let toastTimer = 0;
let panelRaf = 0;

// ---------------------------------------------------------------- 提示 / 忙碌

function showToast(text, kind = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function setHint(text, kind = '') {
  const el = $('convert-status');
  el.textContent = text;
  el.className = `hint ${kind}`;
}

function setBusy(on, text = '处理中…') {
  state.ui.busy = on;
  $('busy').hidden = !on;
  if (text) $('busy-text').textContent = text;
}

function report(res) {
  if (!res || !res.msg) return;
  showToast(res.msg, res.ok ? 'ok' : 'err');
}

// ---------------------------------------------------------------- 字体

/**
 * 默认字体：优先「方正新楷体简体」，未安装时回退「楷体」，再回退到任意中文字体/第一个字体。
 * 抽成纯函数便于 Node 测试。
 */
export function pickDefaultFamily(families) {
  const prefer = ['方正新楷体简体', '方正新楷体', '楷体', 'KaiTi', '楷体_GB2312', '华文楷体', 'STKaiti'];
  const match = (f, p) => f.name.includes(p) || (f.faces || []).some((x) => (x.familyEn || '').includes(p));
  for (const p of prefer) {
    const hit = families.find((f) => f.name === p) || families.find((f) => match(f, p));
    if (hit) return hit;
  }
  return families.find((f) => /[\u4e00-\u9fff]/.test(f.name)) || families[0] || null;
}

async function loadFonts() {
  const list = $('font-list');
  list.innerHTML = '<div class="empty">正在读取系统字体…</div>';
  let fonts = null;
  let err = null;

  try {
    fonts = await invoke('list_fonts', { force: false });
  } catch (e1) {
    err = e1;
    // 回退到 tauri-plugin-system-fonts（无面索引，仅作兜底）
    try {
      const raw = await invoke('plugin:system-fonts|get_system_fonts');
      fonts = (raw || []).map((f, i) => ({
        family: f.name,
        familyEn: f.name,
        subfamily: f.style === 'Italic' ? 'Italic' : String(f.weight) === '700' ? 'Bold' : 'Regular',
        postScriptName: f.fontName,
        path: f.path,
        index: i,
        weight: f.weight,
        style: f.style,
        monospaced: !!f.monospaced,
      }));
    } catch (e2) {
      fonts = null;
    }
  }

  if (!fonts || !fonts.length) {
    list.innerHTML = `<div class="empty">字体读取失败<br><span style="font-size:10px">${esc(
      (err && err.message) || '未知错误'
    )}</span></div>`;
    setHint('字体读取失败，请检查权限配置', 'err');
    return;
  }

  state.fonts = fonts;
  const map = new Map();
  for (const f of fonts) {
    if (!map.has(f.family)) map.set(f.family, []);
    map.get(f.family).push(f);
  }
  state.families = [...map.entries()]
    .map(([name, faces]) => ({ name, faces }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const pick = pickDefaultFamily(state.families);
  if (!pick) return;
  selectFamily(pick.name, true);
  renderFontList();
  setHint(`已加载 ${fonts.length} 个字体面 / ${state.families.length} 个字体族`, 'ok');
}

function renderFontList() {
  const q = $('font-search').value.trim().toLowerCase();
  const items = state.families.filter(
    (f) =>
      !q ||
      f.name.toLowerCase().includes(q) ||
      f.faces.some((x) => (x.familyEn || '').toLowerCase().includes(q) || (x.postScriptName || '').toLowerCase().includes(q))
  );
  const list = $('font-list');
  if (!items.length) {
    list.innerHTML = '<div class="empty">没有匹配的字体</div>';
    return;
  }
  list.innerHTML = items
    .slice(0, 500)
    .map(
      (f) =>
        `<div class="font-item${f.name === state.family ? ' on' : ''}" data-family="${esc(f.name)}" role="option">` +
        `<span class="nm">${esc(f.name)}</span><span class="sub">${f.faces.length}</span></div>`
    )
    .join('');
  const active = list.querySelector('.font-item.on');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function selectFamily(name, silent = false) {
  const fam = state.families.find((f) => f.name === name);
  if (!fam) return;
  state.family = name;
  const sel = $('face-select');
  sel.innerHTML = fam.faces
    .map((f, i) => `<option value="${i}">${esc(f.subfamily)} · ${f.weight}</option>`)
    .join('');
  sel.value = '0';
  state.face = fam.faces[0];
  updateFontMeta();
  if (!silent) renderFontList();
}

function updateFontMeta() {
  const f = state.face;
  if (!f) {
    $('font-meta').textContent = '—';
    $('sb-font').textContent = '—';
    return;
  }
  const base = (f.path || '').split(/[\\/]/).pop() || f.path;
  $('font-meta').textContent = `${base} #${f.index}`;
  $('font-meta').title = `${f.path} (face ${f.index})`;
  $('sb-font').textContent = `${f.family} ${f.subfamily}`;
}

// ---------------------------------------------------------------- 转换

async function emitLine(line, base, { baselineY, lineIndex, startIndex, out, startX = 0, emAscent = 0, emDescent = 0, size = 0 }) {
  const chars = Array.from(line);
  const CHUNK = 200;
  let x = startX;
  let idx = startIndex;
  for (let i = 0; i < chars.length; i += CHUNK) {
    const part = chars.slice(i, i + CHUNK).join('');
    const res = await invoke('outline_text', {
      req: { ...base, text: part, baselineY, offsetX: x, lineIndex, startIndex: idx },
    });
    for (const raw of res.shapes) {
      // 字身框（em box）：pen 起点 + 字宽 + 升部/降部，供「按整字位置保存」使用
      let cellKey = null;
      if (Number.isFinite(raw.penX) && raw.advance > 0) {
        cellKey = `c${state.charSeq}_${raw.charIndex}`;
        state.charCells[cellKey] = G.charCell(raw.penX, raw.advance, size, emAscent, baselineY);
      }
      // 关键：每个轮廓拆成独立路径，保证「每个独立部分可单独选中」
      const parts = [];
      for (const c of raw.contours) {
        const shape = G.shapeFromOutline({ ...raw, contours: [c] }, nextShapeId());
        shape.bbox = G.shapeBBox(shape);
        shape.cellKey = cellKey;
        parts.push(shape);
      }
      // 记下该字符当时的墨迹范围：字身框被移动后可以用它重新锚定
      if (cellKey && state.charCells[cellKey]) {
        let ink = null;
        for (const sp of parts) {
          if (sp.bbox) ink = ink ? G.unionBBox(ink, sp.bbox) : sp.bbox;
        }
        if (ink) state.charCells[cellKey].ink = ink;
      }
      out.push(...parts);
    }
    x += res.advance || 0;
    idx += Array.from(part).length;
    if (chars.length > CHUNK) await nextFrame();
  }
}

/** 当前字体/排版的轮廓化参数（替换转换与画布追加文字共用） */
function textOutlineBase() {
  return {
    fontPath: state.face.path,
    faceIndex: state.face.index || 0,
    size: LAYOUT.size,
    widthScale: 1,
    slantDeg: 0,
    letterSpacing: 0,
  };
}

async function convertText() {
  const text = $('text-input').value;
  if (!text.trim()) {
    setHint('请输入要转换的文字', 'err');
    return;
  }
  if (!state.face || !state.face.path) {
    setHint('请先选择一个可用的系统字体', 'err');
    return;
  }

  const base = textOutlineBase();

  setBusy(true, '正在度量文字…');
  const t0 = performance.now();
  try {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const measure = await invoke('measure_text', { req: { ...base, text: normalized } });
    state.charCells = {};
    state.charSeq += 1;
    const lines = normalized.split('\n');
    const lineH = LAYOUT.leading;
    const parts = [];
    let startIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const baselineY = measure.ascent + i * lineH;
      setBusy(true, `正在轮廓化… 第 ${i + 1}/${lines.length} 行`);
      if (line.trim()) {
        await emitLine(line, base, {
          baselineY,
          lineIndex: i,
          startIndex,
          out: parts,
          emAscent: measure.emAscent,
          emDescent: measure.emDescent,
          size: LAYOUT.size,
        });
      }
      startIndex += Array.from(line).length;
      await nextFrame();
    }

    state.shapes = parts;
    clearSelection();
    clearHistory();
    C.fitView();
    const stats = G.countStats(parts);
    const ms = Math.round(performance.now() - t0);
    emit('edit');

    if (!parts.length) {
      setHint('未生成任何路径：该字体可能缺少所输入字符的字形', 'err');
      return;
    }
    const missing = (measure.missing || []).filter(Boolean);
    if (missing.length) setHint(`字体缺少字符：${missing.join(' ')}（已跳过）`, 'err');
    else setHint(`已生成 ${stats.shapes} 个独立部分 · ${stats.nodes} 个节点 · ${ms} ms`, 'ok');
    showToast(`转换完成：${stats.shapes} 个独立部分`, 'ok');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setHint(`转换失败：${msg}`, 'err');
    showToast(`转换失败：${msg}`, 'err');
  } finally {
    setBusy(false);
  }
}

/**
 * 把量到的文字框放到画布锚点中心：
 * 水平方向 startX = anchor.x - width/2；
 * 垂直方向 baseline = anchor.y + (ascent + descent)/2（y 轴向下）。
 */
export function textAnchorFrame(measure, anchor) {
  const width = (measure.lineWidths && measure.lineWidths[0]) || measure.maxWidth || 0;
  const ascent = Number.isFinite(measure.ascent) ? measure.ascent : LAYOUT.size * 0.8;
  const descent = Number.isFinite(measure.descent) ? measure.descent : 0;
  const x = Number.isFinite(anchor && anchor.x) ? anchor.x : 0;
  const y = Number.isFinite(anchor && anchor.y) ? anchor.y : 0;
  return {
    startX: x - width / 2,
    baselineY: y + (ascent + descent) / 2,
  };
}

/**
 * 在画布上追加一段文字：旧路径完全不动，新文字以双击位置为视觉中心，
 * 自动进入撤销栈（Ctrl+Z 可撤销这次添加）。
 */
async function addTextAt(text, anchor) {
  const value = String(text || '').trim();
  if (!value) return;
  if (!state.face || !state.face.path) {
    setHint('请先选择一个可用的系统字体', 'err');
    return;
  }

  const base = textOutlineBase();
  const ax = Number.isFinite(anchor && anchor.x) ? anchor.x : 0;
  const ay = Number.isFinite(anchor && anchor.y) ? anchor.y : 0;

  setBusy(true, '正在添加文字…');
  const t0 = performance.now();
  try {
    const measure = await invoke('measure_text', { req: { ...base, text: value } });
    const frame = textAnchorFrame(measure, { x: ax, y: ay });

    const parts = [];
    state.charSeq += 1;
    await emitLine(value, base, {
      baselineY: frame.baselineY,
      lineIndex: 0,
      startIndex: 0,
      out: parts,
      startX: frame.startX,
      emAscent: measure.emAscent,
      emDescent: measure.emDescent,
      size: LAYOUT.size,
    });

    if (!parts.length) {
      setHint('未生成任何路径：该字体可能缺少所输入字符的字形', 'err');
      showToast('没有可添加的字形', 'err');
      return;
    }

    // 关键：先记录旧文档快照，再追加；旧路径的几何与顺序保持不变
    pushHistory();
    state.shapes.push(...parts);
    emit('edit');

    const stats = G.countStats(parts);
    const ms = Math.round(performance.now() - t0);
    const missing = (measure.missing || []).filter(Boolean);
    if (missing.length) setHint(`字体缺少字符：${missing.join(' ')}（已跳过）`, 'err');
    else setHint(`已添加 ${stats.shapes} 个独立部分 · ${stats.nodes} 个节点 · ${ms} ms`, 'ok');
    showToast(`已添加文字：${stats.shapes} 个独立部分`, 'ok');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setHint(`添加文字失败：${msg}`, 'err');
    showToast(`添加文字失败：${msg}`, 'err');
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- 画布快捷输入

/**
 * 双击画布空白处弹出单行输入框：Enter 确认后在双击位置追加文字（保留旧路径），Esc 取消。
 * 输入框挂在 #stage 上，位置取双击处的画布坐标。
 */
function openCanvasTextInput({ px, py, x, y }) {
  if (state.ui.busy) return;
  const stage = $('stage');
  const old = $('canvas-text-input');
  if (old) old.remove();

  const input = document.createElement('input');
  input.id = 'canvas-text-input';
  input.className = 'canvas-text-input';
  input.type = 'text';
  input.placeholder = '输入文字，回车转换';
  input.setAttribute('aria-label', '画布文字输入');
  input.spellcheck = false;

  const width = Math.min(240, Math.max(160, stage.clientWidth - 16));
  const left = G.clamp(px - width / 2, 8, Math.max(8, stage.clientWidth - width - 8));
  const top = G.clamp(py - 16, 8, Math.max(8, stage.clientHeight - 38));
  input.style.left = `${left}px`;
  input.style.top = `${top}px`;
  input.style.width = `${width}px`;

  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.isComposing) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const text = input.value.trim();
      input.remove();
      if (!text) return;
      // 双击输入是“追加”，不覆盖画布上已有路径
      addTextAt(text, { x, y });
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      input.remove();
    }
  });
  // 点到别处即取消，避免残留一个透明输入框
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (input.parentElement) input.remove();
    }, 120);
  });

  stage.appendChild(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

// ---------------------------------------------------------------- 笔画列表

/**
 * 把笔画几何画到列表里的小预览画布上。
 * 有字身框（部首）时按框铺满并画出田字格，直观显示它在字中的位置；
 * 没有框（基本笔画）时按自身包围盒居中放大。
 */
function drawStrokeThumb(cv, contours, frame) {
  const size = 46;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  cv.style.width = `${size}px`;
  cv.style.height = `${size}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const list = (contours || []).filter(Boolean);
  let ink = null;
  for (const c of list) {
    const b = G.contourBBox(c);
    if (b) ink = ink ? G.unionBBox(ink, b) : b;
  }
  // 字身框若与墨迹错位（旧数据 / 字被挪过），取并集，宁可多留白也不能什么都看不见
  let box = frame ? (ink ? G.unionBBox(frame, ink) : { ...frame }) : ink;
  if (!box) return;

  const pad = frame ? 0 : 5;
  const w = Math.max(box.w, 1e-6);
  const h = Math.max(box.h, 1e-6);
  const s = Math.min((size - pad * 2) / w, (size - pad * 2) / h);

  if (frame) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(s, s);
  ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
  ctx.strokeStyle = '#b9c3d6';
  ctx.lineWidth = (frame ? 1 : 1.2) / s;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const c of list) {
    const d = G.contourToPathData(c);
    if (d) ctx.stroke(new Path2D(d));
  }
  ctx.restore();
}

function renderStrokeList() {
  const list = $('stroke-list');
  $('stroke-count').textContent = String(state.strokes.length);
  if (!state.strokes.length) {
    list.innerHTML = '<div class="empty">选中闭合路径后点上方按钮<br />即可加入笔画列表</div>';
    return;
  }
  const exW = state.ui.exWidth;
  list.innerHTML = state.strokes
    .map((s) => {
      const contours = s.contours || (s.contour ? [s.contour] : []);
      const nodes = contours.reduce((n, c) => n + c.nodes.length, 0);
      const closed = contours.length > 0 && contours.every((c) => c.closed);
      return (
        `<div class="stroke-item" data-id="${s.id}">` +
        `<canvas class="stroke-thumb" data-id="${s.id}"></canvas>` +
        `<div class="stroke-body">` +
        `<div class="stroke-row">` +
        `<input class="stroke-name" data-id="${s.id}" data-field="name" value="${esc(s.name)}" title="笔画名称（导出文件名）" spellcheck="false" />` +
        `<button class="stroke-sync" data-id="${s.id}" title="用当前选中的闭合路径更新该笔画">↻</button>` +
        `<button class="stroke-del" data-id="${s.id}" title="删除">×</button>` +
        `</div>` +
        `<div class="stroke-row">` +
        `<input class="stroke-ex" data-id="${s.id}" data-field="example" style="width:${exW}px" value="${esc(s.example)}" title="例字，可填多个（仅备注，不导出）" placeholder="例字" spellcheck="false" />` +
        `<span class="ex-grip" title="拖动调整例字栏宽度"></span>` +
        `<span class="stroke-meta" title="${closed ? '闭合' : '混合'} · ${contours.length} 条轮廓 · ${nodes} 节点">${contours.length}轮廓·${nodes}节点</span>` +
        `</div>` +
        `</div>` +
        `</div>`
      );
    })
    .join('');

  list.querySelectorAll('.stroke-thumb').forEach((cv) => {
    const s = state.strokes.find((x) => x.id === cv.dataset.id);
    if (s) drawStrokeThumb(cv, s.contours || (s.contour ? [s.contour] : []), s.frame || null);
  });
}

// ---------------------------------------------------------------- 面板刷新

let needStrokeRefresh = false;

function schedulePanels(reason = '') {
  // 笔画库只在真正变化时重建；选择/几何编辑不需要重绘所有缩略图
  if (reason === 'strokes' || reason === 'undo' || reason === 'redo') needStrokeRefresh = true;
  if (panelRaf) return;
  panelRaf = requestAnimationFrame(() => {
    panelRaf = 0;
    const refreshStrokes = needStrokeRefresh;
    needStrokeRefresh = false;
    refreshPanels(refreshStrokes);
  });
}

function refreshPanels(refreshStrokes = false) {
  if (refreshStrokes) renderStrokeList();
  updateUndoRedo();
  updateZoom();
  updateSelectionText();
  updateExportHint();
}

function updateExportHint() {
  const el = $('stroke-hint');
  if (!el) return;
  if (state.exportDir) {
    el.textContent = `导出目录：${state.exportDir}`;
    el.title = state.exportDir;
  } else {
    el.textContent = '仅导出描边线条，文件名使用笔画名称。首次导出时选择目录。';
    el.title = '';
  }
}

async function chooseExportDir() {
  try {
    const dir = await invoke('choose_folder');
    if (!dir) return;
    setExportDir(dir);
    updateExportHint();
    showToast(`批量导出目录：${dir}`, 'ok');
  } catch (err) {
    showToast(`选择目录失败：${err && err.message ? err.message : err}`, 'err');
  }
}

function updateUndoRedo() {
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
}

function updateZoom() {
  const z = `${Math.round(state.view.scale * 100)}%`;
  $('zoom-label').textContent = z;
  $('sb-zoom').textContent = z;
}

function updateCoord() {
  const p = C.pointer;
  $('sb-coord').textContent = `x ${p.wx.toFixed(1)}　y ${p.wy.toFixed(1)}`;
}

function updateSelectionText() {
  const ns = state.selection.nodes.size;
  const ss = state.selection.shapes.size;
  const el = $('sb-sel');
  if (ns) el.textContent = `选中 ${ns} 个节点`;
  else if (ss) el.textContent = `选中 ${ss} 个部分`;
  else el.textContent = '未选中';
}

// ---------------------------------------------------------------- 工具

function setTool(tool) {
  const next = state.ui.tool === tool ? 'select' : tool;
  C.setTool(next);
  $('btn-cut').classList.toggle('on', next === 'cut');
  $('tool-hint').textContent =
    next === 'cut'
      ? '点切断已激活：在路径上单击即可切断，靠近节点会自动吸附。按 Esc 退出。'
      : '尺寸请直接拖拽选框四角调整。';
  $('sb-hint').textContent = next === 'cut' ? '点切断' : '就绪';
}

// ---------------------------------------------------------------- 绑定

function bindFonts() {
  $('text-input').addEventListener('input', markDirty);
  $('font-search').addEventListener('input', renderFontList);
  $('font-list').addEventListener('click', (e) => {
    const item = e.target.closest('.font-item');
    if (!item) return;
    selectFamily(item.dataset.family);
  });
  $('face-select').addEventListener('change', (e) => {
    const fam = state.families.find((f) => f.name === state.family);
    if (!fam) return;
    state.face = fam.faces[Number(e.target.value)] || fam.faces[0];
    updateFontMeta();
  });
}

function bindOptions() {
  $('chk-nodes').addEventListener('change', (e) => {
    state.ui.showNodes = e.target.checked;
    C.requestRender();
  });
  $('chk-grid').addEventListener('change', (e) => {
    state.ui.showGrid = e.target.checked;
    C.requestRender();
  });
}

/** 同步「按整字位置保存」开关带来的按钮文案与提示 */
function updateSaveMode() {
  const on = !!state.ui.radicalMode;
  const btn = $('btn-add-stroke');
  const hint = $('save-mode-hint');
  if (btn) btn.textContent = on ? '添加选中部首' : '添加选中笔画';
  if (hint) {
    hint.textContent = on ? '打开：按整字位置保存，导出后可在田字格原位显示' : '关闭：单笔居中放大（基本笔画）';
    hint.className = `hint tight ${on ? 'ok' : ''}`;
  }
}

function bindButtons() {
  $('btn-convert').addEventListener('click', convertText);
  $('btn-undo').addEventListener('click', () => undo());
  $('btn-redo').addEventListener('click', () => redo());
  $('btn-fit').addEventListener('click', () => C.fitView());
  $('btn-zoom-in').addEventListener('click', () => C.zoomBy(1.2));
  $('btn-zoom-out').addEventListener('click', () => C.zoomBy(1 / 1.2));
  $('btn-export-sel').addEventListener('click', () => exportShapes('selected'));
  $('btn-export-all').addEventListener('click', () => exportShapes('all'));

  $('btn-cut').addEventListener('click', () => setTool('cut'));
  $('btn-join').addEventListener('click', () => report(E.joinSelectedEndpoints()));
  $('btn-close-line').addEventListener('click', () => report(E.closeSelectedContours('line')));
  $('btn-close-arc').addEventListener('click', () => report(E.closeSelectedContours('arc')));
  $('btn-insert').addEventListener('click', () => report(E.insertNodeAfterSelected()));
  $('btn-delete').addEventListener('click', () => report(E.deleteSelection()));

  $('btn-add-stroke').addEventListener('click', () => {
    report(E.addStrokesFromSelection());
  });

  const radicalChk = $('chk-radical');
  if (radicalChk) {
    radicalChk.checked = !!state.ui.radicalMode;
    radicalChk.addEventListener('change', (e) => {
      state.ui.radicalMode = e.target.checked;
      updateSaveMode();
    });
  }
  updateSaveMode();
  $('btn-export-strokes').addEventListener('click', async () => {
    await exportStrokes();
    updateExportHint();
  });
  $('btn-export-dir').addEventListener('click', chooseExportDir);

  const list = $('stroke-list');
  list.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp.classList.contains('stroke-name') && !inp.classList.contains('stroke-ex')) return;
    const stroke = state.strokes.find((s) => s.id === inp.dataset.id);
    if (!stroke) return;
    if (inp.dataset.field === 'name') stroke.name = inp.value;
    else stroke.example = inp.value;
  });
  list.addEventListener('click', (e) => {
    const sync = e.target.closest('.stroke-sync');
    if (sync) {
      report(E.updateStrokeGeometry(sync.dataset.id));
      return;
    }
    const btn = e.target.closest('.stroke-del');
    if (!btn) return;
    E.removeStroke(btn.dataset.id);
  });

  // 拖动分隔条调整例字栏宽度（可容纳多个例字）
  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.ex-grip');
    if (!grip) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = state.ui.exWidth;
    grip.classList.add('dragging');
    const onMove = (ev) => {
      state.ui.exWidth = Math.round(Math.min(240, Math.max(48, startW + ev.clientX - startX)));
      list.querySelectorAll('.stroke-ex').forEach((inp) => {
        inp.style.width = `${state.ui.exWidth}px`;
      });
    };
    const onUp = () => {
      grip.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const ctrl = e.ctrlKey || e.metaKey;

    // 输入框内保留系统/输入框自己的快捷键（撤销、删除、全选等），只保留 Ctrl+Enter 转换
    if (typing) {
      if (ctrl && e.key === 'Enter') {
        e.preventDefault();
        convertText();
      }
      return;
    }

    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (ctrl && e.key === 'Enter') {
      e.preventDefault();
      convertText();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setTool('cut');
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      report(E.joinSelectedEndpoints());
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      E.selectAll();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrent();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openLibrary();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      exportShapes(e.shiftKey ? 'all' : 'selected');
      return;
    }

    if (e.key === 'Escape') {
      if (!$('library').hidden) {
        closeLibrary();
        return;
      }
      if (state.ui.tool !== 'select') setTool('cut');
      else {
        clearSelection();
        emit('selection');
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      report(E.deleteSelection());
    } else if (e.key.toLowerCase() === 'f') {
      C.fitView();
    } else if (e.key.toLowerCase() === 'i') {
      report(E.insertNodeAfterSelected());
    }
  });
}

// ---------------------------------------------------------------- 作品库

function defaultProjectName() {
  const first = $('text-input').value.trim().split('\n')[0];
  return first ? first.slice(0, 20) : '未命名';
}

function markDirty() {
  if (!state.project) state.project = { id: null, name: '', dirty: false };
  if (!state.project.dirty) {
    state.project.dirty = true;
    updateSaveButton();
  }
}

function updateSaveButton() {
  const btn = $('btn-save');
  if (!btn) return;
  const dirty = !!state.project?.dirty;
  btn.textContent = dirty ? '保存 •' : '保存';
  btn.title = state.project?.name ? `保存「${state.project.name}」(Ctrl+S)` : '保存作品 (Ctrl+S)';
}

async function saveCurrent(explicitName) {
  if (!state.shapes.length) {
    showToast('画布上没有内容，无法保存', 'err');
    return;
  }
  const name = (explicitName || state.project?.name || defaultProjectName()).trim() || '未命名';
  try {
    const meta = await P.saveProject({
      id: state.project?.id || null,
      name,
      text: $('text-input').value,
    });
    state.project = { id: meta.id, name: meta.name, dirty: false };
    updateSaveButton();
    showToast(`已保存「${meta.name}」`, 'ok');
    if (!$('library').hidden) renderLibrary();
  } catch (err) {
    showToast(`保存失败：${err && err.message ? err.message : err}`, 'err');
  }
}

/** 从工程记录里恢复字体；找不到同名字体时返回 false（保留当前字体） */
function applyFontFromDoc(font) {
  if (!font) return true;
  const fam = state.families.find((f) => f.name === font.family);
  if (!fam) return false;
  const face = fam.faces.find((f) => f.subfamily === font.subfamily) || fam.faces[0];
  state.family = fam.name;
  state.face = face;
  syncFontUI();
  return true;
}

/** 用 state 里的字体信息刷新字重下拉、字体列表高亮与底部状态 */
function syncFontUI() {
  const fam = state.families.find((f) => f.name === state.family);
  if (!fam) return;
  const sel = $('face-select');
  sel.innerHTML = fam.faces
    .map((f, i) => `<option value="${i}">${esc(f.subfamily)} · ${f.weight}</option>`)
    .join('');
  const idx = fam.faces.indexOf(state.face);
  sel.value = String(idx < 0 ? 0 : idx);
  updateFontMeta();
  renderFontList();
}

async function openProject(id) {
  try {
    const raw = await P.loadProject(id);
    const info = P.applyDoc(raw);
    state.project = { id, name: info.name, dirty: false };
    $('text-input').value = info.text;
    const fontOk = applyFontFromDoc(info.font);
    updateSaveButton();
    C.fitView();
    // 打开工程后右侧笔画列表也必须重建（refreshPanels 默认不动笔画库）
    refreshPanels(true);
    closeLibrary();
    if (!fontOk) showToast(`已打开「${info.name}」，但原字体不可用，沿用当前字体`, 'err');
    else showToast(`已打开「${info.name}」`, 'ok');
  } catch (err) {
    showToast(`打开失败：${err && err.message ? err.message : err}`, 'err');
  }
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderLibrary() {
  const grid = $('lib-grid');
  grid.innerHTML = '<div class="empty">正在读取…</div>';
  let items = [];
  try {
    items = await P.listProjects();
  } catch (err) {
    grid.innerHTML = `<div class="empty">读取失败：${esc(err && err.message ? err.message : err)}</div>`;
    return;
  }
  $('lib-count').textContent = String(items.length);
  if (!items.length) {
    grid.innerHTML = '<div class="empty">还没有保存过作品</div>';
    return;
  }
  grid.innerHTML = items
    .map(
      (it) =>
        `<div class="lib-card${it.id === state.project?.id ? ' on' : ''}" data-id="${esc(it.id)}">` +
        (it.thumb ? `<img class="thumb" src="${it.thumb}" alt="" />` : '<div class="thumb"></div>') +
        `<div class="meta">` +
        `<div class="nm" title="${esc(it.name)}">${esc(it.name)}</div>` +
        `<div class="sub">${fmtTime(it.updatedAt)} · ${it.shapes || 0}路径 ${it.strokes || 0}笔画</div>` +
        `</div>` +
        `<button class="del" data-del="${esc(it.id)}" data-name="${esc(it.name)}" title="删除">×</button>` +
        `</div>`
    )
    .join('');
}

async function openLibrary() {
  $('library').hidden = false;
  $('lib-name').value = state.project?.name || defaultProjectName();
  await renderLibrary();
  $('lib-name').focus();
  $('lib-name').select();
}

function closeLibrary() {
  $('library').hidden = true;
}

function bindLibrary() {
  $('btn-save').addEventListener('click', () => saveCurrent());
  $('btn-library').addEventListener('click', () => openLibrary());
  $('lib-close').addEventListener('click', () => closeLibrary());
  $('lib-save').addEventListener('click', async () => {
    await saveCurrent($('lib-name').value);
  });
  $('lib-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveCurrent($('lib-name').value);
    }
  });
  $('library').addEventListener('click', (e) => {
    if (e.target === $('library')) closeLibrary();
  });

  const grid = $('lib-grid');
  grid.addEventListener('click', async (e) => {
    const del = e.target.closest('.del');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      const nm = del.dataset.name || '该作品';
      if (!window.confirm(`删除作品「${nm}」？此操作不可撤销。`)) return;
      try {
        await P.removeProject(id);
        if (state.project?.id === id) state.project = { id: null, name: '', dirty: true };
        updateSaveButton();
        await renderLibrary();
        showToast('已删除', 'ok');
      } catch (err) {
        showToast(`删除失败：${err && err.message ? err.message : err}`, 'err');
      }
      return;
    }
    const card = e.target.closest('.lib-card');
    if (card) openProject(card.dataset.id);
  });
}

// ---------------------------------------------------------------- 启动

export async function initUI() {
  onToast(showToast);

  bindFonts();
  bindOptions();
  bindButtons();
  bindLibrary();
  bindKeyboard();
  updateSaveButton();
  C.setBlankDblClickHandler(openCanvasTextInput);

  subscribe((reason) => {
    if (reason === 'pointer') {
      updateCoord();
      return;
    }
    C.requestRender();
    if (reason === 'zoom') {
      updateZoom();
      return;
    }
    if (reason === 'edit') markDirty();
    schedulePanels(reason);
  });

  await loadFonts();
  C.fitView();
  refreshPanels(true);

  if (!isTauri) {
    setHint('当前为浏览器预览模式（后端未连接），字体与轮廓为模拟数据', 'err');
  }

  if (state.face) {
    convertText();
  }
}
