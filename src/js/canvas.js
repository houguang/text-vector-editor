// 画布渲染与交互：缩放/平移、路径与节点绘制、选择、拖拽、框选、控制柄、整体缩放。

import * as G from './geometry.js';
import * as E from './edits.js';
import { state, emit, pushHistory, subscribe, toast } from './state.js';

const COL = {
  bg: '#0a0c10',
  grid: 'rgba(255,255,255,0.05)',
  gridStrong: 'rgba(255,255,255,0.085)',
  curve: '#b9c3d6',
  curveSel: '#ff9d2e',
  bbox: 'rgba(255,157,46,0.5)',
  node: '#94a4bd',
  nodeFill: '#0a0c10',
  nodeSel: '#ff9d2e',
  handle: '#4da3ff',
  handleLine: 'rgba(77,163,255,0.6)',
  rubber: 'rgba(77,163,255,0.85)',
  rubberFill: 'rgba(77,163,255,0.07)',
};

const NODE_SIZE = 7;
const HIT_TOL = 8;

let canvas = null;
let ctx = null;
let dpr = 1;
let W = 0;
let H = 0;
let raf = 0;
let drag = null;
let hover = null;
let spaceDown = false;
let selBoxCache = null;
let blankDblClickHandler = null;

// 渲染/命中测试缓存：几何在拖拽期间实时变化，此时绕过缓存；其余时间复用
const pathCache = new Map(); // shape.id -> { shape, path }
let hitIndex = null; // { shapes, entries:[{ shape, box }] }

function clearRenderCaches() {
  pathCache.clear();
  hitIndex = null;
}

function isMutatingDrag() {
  return !!drag && (drag.type === 'nodes' || drag.type === 'shape' || drag.type === 'scale' || drag.type === 'handle');
}

function shapePath(shape) {
  const cached = pathCache.get(shape.id);
  if (!isMutatingDrag() && cached && cached.shape === shape) return cached.path;
  const d = G.shapeToPathData(shape);
  const path = d ? new Path2D(d) : null;
  if (!isMutatingDrag()) pathCache.set(shape.id, { shape, path });
  return path;
}

function hitEntries() {
  if (!hitIndex || hitIndex.shapes !== state.shapes) {
    hitIndex = {
      shapes: state.shapes,
      entries: state.shapes.map((shape) => ({ shape, box: G.shapeBBox(shape) })),
    };
  }
  return hitIndex.entries;
}

function boxContains(box, x, y, pad = 0) {
  return !!box && x >= box.x - pad && x <= box.x + box.w + pad && y >= box.y - pad && y <= box.y + box.h + pad;
}

function hoverKey(h) {
  if (!h) return '';
  if (h.type === 'cut') {
    const c = h.cut;
    return `cut|${c.kind}|${c.sid}|${c.ni ?? ''}|${c.si ?? ''}|${c.t ?? ''}`;
  }
  return `${h.type}|${h.key || ''}`;
}

export const pointer = { x: 0, y: 0, wx: 0, wy: 0, inside: false };

// ---------------------------------------------------------------- 坐标换算

const toScreen = (x, y) => ({ x: x * state.view.scale + state.view.tx, y: y * state.view.scale + state.view.ty });
const toWorld = (x, y) => ({ x: (x - state.view.tx) / state.view.scale, y: (y - state.view.ty) / state.view.scale });

function localPos(e) {
  const r = canvas.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}

// ---------------------------------------------------------------- 初始化

export function initCanvas(el) {
  canvas = el;
  ctx = el.getContext('2d', { alpha: false });

  const ro = new ResizeObserver(resize);
  ro.observe(el.parentElement || el);
  resize();

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('pointerleave', () => {
    pointer.inside = false;
    hover = null;
    requestRender();
  });
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dblclick', onDblClick);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping(e)) {
      spaceDown = true;
      canvas.classList.add('pannable');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      canvas.classList.remove('pannable');
    }
  });
  // 失焦时可能收不到 keyup，避免空格平移状态卡住
  window.addEventListener('blur', () => {
    spaceDown = false;
    canvas.classList.remove('pannable');
  });

  // 编辑/撤销/重做后几何或对象身份变化，缓存必须失效
  subscribe((reason) => {
    if (reason === 'edit' || reason === 'undo' || reason === 'redo') clearRenderCaches();
  });
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function resize() {
  if (!canvas) return;
  const parent = canvas.parentElement;
  W = parent.clientWidth;
  H = parent.clientHeight;
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(W * dpr));
  canvas.height = Math.max(1, Math.round(H * dpr));
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  requestRender();
}

export function requestRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}

// ---------------------------------------------------------------- 渲染

function render() {
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);

  if (state.ui.showGrid) drawGrid();

  ctx.save();
  ctx.setTransform(dpr * state.view.scale, 0, 0, dpr * state.view.scale, dpr * state.view.tx, dpr * state.view.ty);

  const selShapes = state.shapes.filter((s) => state.selection.shapes.has(s.id));

  // 未选中路径
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = COL.curve;
  ctx.lineWidth = 1.15 / state.view.scale;
  for (const s of state.shapes) {
    if (state.selection.shapes.has(s.id)) continue;
    const path = shapePath(s);
    if (path) ctx.stroke(path);
  }

  // 选中路径
  ctx.strokeStyle = COL.curveSel;
  ctx.lineWidth = 1.9 / state.view.scale;
  for (const s of selShapes) {
    const path = shapePath(s);
    if (path) ctx.stroke(path);
  }
  ctx.restore();

  // 以下为屏幕空间绘制（保持像素尺寸恒定）
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (selShapes.length) {
    const box = G.shapesBBox(selShapes);
    selBoxCache = box;
    if (box) {
      drawSelectionBox(box);
      drawScaleHandles(box);
    }
  } else {
    selBoxCache = null;
  }

  if (state.ui.showNodes) drawNodes(selShapes);
  if (state.ui.tool === 'cut' && hover && hover.cut) drawCutSnap(hover.cut);
  if (drag && drag.type === 'rubber') drawRubber(drag.start, pointer);
}

function drawCutSnap(t) {
  const p = toScreen(t.x, t.y);
  ctx.save();
  ctx.strokeStyle = '#ff9d2e';
  ctx.fillStyle = 'rgba(255,157,46,0.18)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - 12, p.y);
  ctx.lineTo(p.x - 8, p.y);
  ctx.moveTo(p.x + 8, p.y);
  ctx.lineTo(p.x + 12, p.y);
  ctx.moveTo(p.x, p.y - 12);
  ctx.lineTo(p.x, p.y - 8);
  ctx.moveTo(p.x, p.y + 8);
  ctx.lineTo(p.x, p.y + 12);
  ctx.stroke();
  ctx.restore();
}

function drawGrid() {
  const s = state.view.scale;
  let step = 50;
  while (step * s < 14) step *= 5;
  while (step * s > 160) step /= 5;
  const x0 = Math.floor(-state.view.tx / s / step) * step;
  const y0 = Math.floor(-state.view.ty / s / step) * step;
  const x1 = x0 + (W / s) + step * 2;
  const y1 = y0 + (H / s) + step * 2;

  ctx.save();
  ctx.lineWidth = 1;
  for (let x = x0; x <= x1; x += step) {
    const sx = Math.round(x * s + state.view.tx) + 0.5;
    const major = Math.abs(x % (step * 5)) < 1e-6;
    ctx.strokeStyle = major ? COL.gridStrong : COL.grid;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, H);
    ctx.stroke();
  }
  for (let y = y0; y <= y1; y += step) {
    const sy = Math.round(y * s + state.view.ty) + 0.5;
    const major = Math.abs(y % (step * 5)) < 1e-6;
    ctx.strokeStyle = major ? COL.gridStrong : COL.grid;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(W, sy);
    ctx.stroke();
  }
  // 原点标记
  const o = toScreen(0, 0);
  if (o.x > -20 && o.x < W + 20 && o.y > -20 && o.y < H + 20) {
    ctx.strokeStyle = 'rgba(255,157,46,0.35)';
    ctx.beginPath();
    ctx.moveTo(o.x - 8, o.y);
    ctx.lineTo(o.x + 8, o.y);
    ctx.moveTo(o.x, o.y - 8);
    ctx.lineTo(o.x, o.y + 8);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSelectionBox(box) {
  const a = toScreen(box.x, box.y);
  const b = toScreen(box.x + box.w, box.y + box.h);
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = COL.bbox;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
  ctx.restore();
}

const CORNERS = [
  ['nw', 0, 0],
  ['ne', 1, 0],
  ['se', 1, 1],
  ['sw', 0, 1],
];

function cornerPoints(box) {
  const a = toScreen(box.x, box.y);
  const b = toScreen(box.x + box.w, box.y + box.h);
  return [
    { name: 'nw', x: a.x, y: a.y },
    { name: 'ne', x: b.x, y: a.y },
    { name: 'se', x: b.x, y: b.y },
    { name: 'sw', x: a.x, y: b.y },
  ];
}

function drawScaleHandles(box) {
  ctx.save();
  ctx.fillStyle = COL.nodeFill;
  ctx.strokeStyle = COL.curveSel;
  ctx.lineWidth = 1.4;
  for (const p of cornerPoints(box)) {
    ctx.beginPath();
    ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawNodes(selShapes) {
  const s = state.view.scale;
  ctx.save();
  // 控制柄
  for (const shape of selShapes) {
    shape.contours.forEach((c, ci) => {
      c.nodes.forEach((n, ni) => {
        if (!state.selection.nodes.has(G.nodeKey(shape.id, ci, ni))) return;
        const p = toScreen(n.x, n.y);
        for (const which of ['in', 'out']) {
          const h = n[which];
          if (!h) continue;
          const hp = toScreen(h.x, h.y);
          ctx.strokeStyle = COL.handleLine;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(hp.x, hp.y);
          ctx.stroke();
          ctx.fillStyle = COL.handle;
          ctx.beginPath();
          ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    });
  }

  // 节点
  for (const shape of selShapes) {
    shape.contours.forEach((c, ci) => {
      const len = c.nodes.length;
      c.nodes.forEach((n, ni) => {
        const key = G.nodeKey(shape.id, ci, ni);
        const p = toScreen(n.x, n.y);
        if (p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) return;
        const selected = state.selection.nodes.has(key);
        const isHover = hover && hover.type === 'node' && hover.key === key;
        const endpoint = !c.closed && (ni === 0 || ni === len - 1);
        const size = endpoint ? NODE_SIZE + 1.5 : NODE_SIZE;
        const half = size / 2;

        ctx.beginPath();
        if (endpoint) ctx.arc(p.x, p.y, half, 0, Math.PI * 2);
        else ctx.rect(p.x - half, p.y - half, size, size);

        if (selected) {
          ctx.fillStyle = COL.nodeSel;
          ctx.fill();
          ctx.strokeStyle = '#ffe0b8';
        } else {
          ctx.fillStyle = COL.nodeFill;
          ctx.fill();
          ctx.strokeStyle = isHover ? '#ffffff' : COL.node;
        }
        ctx.lineWidth = 1.3;
        ctx.stroke();
      });
    });
  }
  ctx.restore();
}

function drawRubber(a, b) {
  const p1 = toScreen(a.x, a.y);
  const p2 = toScreen(b.wx, b.wy);
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);
  ctx.save();
  ctx.fillStyle = COL.rubberFill;
  ctx.strokeStyle = COL.rubber;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  ctx.restore();
}

// ---------------------------------------------------------------- 命中测试

function hitNodeAt(px, py) {
  for (const shape of state.shapes) {
    if (!state.selection.shapes.has(shape.id)) continue;
    for (let ci = 0; ci < shape.contours.length; ci++) {
      const nodes = shape.contours[ci].nodes;
      for (let ni = 0; ni < nodes.length; ni++) {
        const p = toScreen(nodes[ni].x, nodes[ni].y);
        if (Math.abs(p.x - px) <= HIT_TOL && Math.abs(p.y - py) <= HIT_TOL) {
          return { sid: shape.id, ci, ni, key: G.nodeKey(shape.id, ci, ni) };
        }
      }
    }
  }
  return null;
}

function hitHandleAt(px, py) {
  for (const shape of state.shapes) {
    if (!state.selection.shapes.has(shape.id)) continue;
    for (let ci = 0; ci < shape.contours.length; ci++) {
      const nodes = shape.contours[ci].nodes;
      for (let ni = 0; ni < nodes.length; ni++) {
        if (!state.selection.nodes.has(G.nodeKey(shape.id, ci, ni))) continue;
        const n = nodes[ni];
        for (const which of ['in', 'out']) {
          const h = n[which];
          if (!h) continue;
          const p = toScreen(h.x, h.y);
          if (Math.hypot(p.x - px, p.y - py) <= HIT_TOL) return { sid: shape.id, ci, ni, which };
        }
      }
    }
  }
  return null;
}

function hitBBoxCorner(px, py) {
  const box = G.shapesBBox(state.shapes.filter((s) => state.selection.shapes.has(s.id)));
  if (!box) return null;
  const pts = cornerPoints(box);
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(pts[i].x - px, pts[i].y - py) <= 8) {
      return { index: i, box, corner: pts[i] };
    }
  }
  return null;
}

function hitShapeAt(wp) {
  const tol = 6 / state.view.scale;
  let best = null;
  for (const { shape, box } of hitEntries()) {
    if (!boxContains(box, wp.x, wp.y, tol)) continue;
    const h = G.hitShape(shape, wp, tol);
    if (h && (!best || h.dist < best.hit.dist)) best = { shape, hit: h };
  }
  return best;
}

/** 点切断工具的吸附目标：优先吸附顶点，否则取路径上最近点 */
function hitCutTarget(wp) {
  let bestVertex = null;
  let bestDist = 14; // 屏幕像素
  const vTol = 14 / state.view.scale;
  for (const { shape, box } of hitEntries()) {
    if (!boxContains(box, wp.x, wp.y, vTol)) continue;
    const c = shape.contours[0];
    if (!c) continue;
    for (let ni = 0; ni < c.nodes.length; ni++) {
      const n = c.nodes[ni];
      const p = toScreen(n.x, n.y);
      const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
      if (d < bestDist) {
        bestDist = d;
        bestVertex = { kind: 'vertex', sid: shape.id, ni, x: n.x, y: n.y };
      }
    }
  }
  if (bestVertex) return bestVertex;

  const tol = 10 / state.view.scale;
  let bestSeg = null;
  for (const { shape, box } of hitEntries()) {
    if (!boxContains(box, wp.x, wp.y, tol)) continue;
    const h = G.hitShape(shape, wp, tol);
    if (h && (!bestSeg || h.dist < bestSeg.hit.dist)) bestSeg = { shape, hit: h };
  }
  if (bestSeg) {
    return {
      kind: 'point',
      sid: bestSeg.shape.id,
      si: bestSeg.hit.si,
      t: bestSeg.hit.t,
      x: bestSeg.hit.x,
      y: bestSeg.hit.y,
    };
  }
  return null;
}

function performCut(wp) {
  const target = hitCutTarget(wp);
  if (!target) {
    toast('请点击路径上的节点或线条', 'err');
    return;
  }
  const res = E.cutAt(target.sid, target.kind === 'vertex' ? { ni: target.ni } : { si: target.si, t: target.t });
  toast(res.msg, res.ok ? 'ok' : 'err');
  hover = null;
  requestRender();
}

// ---------------------------------------------------------------- 交互

function onPointerDown(e) {
  const { px, py } = localPos(e);
  const wp = toWorld(px, py);
  pointer.x = px;
  pointer.y = py;
  pointer.wx = wp.x;
  pointer.wy = wp.y;
  pointer.inside = true;

  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    drag = { type: 'pan', start: { x: px, y: py }, view: { ...state.view } };
    canvas.classList.add('panning');
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无捕获 */ }
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无捕获 */ }

  // 点切断工具：先选工具，再在路径上单击
  if (state.ui.tool === 'cut') {
    performCut(wp);
    return;
  }

  const corner = hitBBoxCorner(px, py);
  if (corner) {
    const shapes = state.shapes.filter((s) => state.selection.shapes.has(s.id));
    const box = corner.box;
    const anchor = {
      x: corner.corner.name === 'nw' || corner.corner.name === 'sw' ? box.x + box.w : box.x,
      y: corner.corner.name === 'nw' || corner.corner.name === 'ne' ? box.y + box.h : box.y,
    };
    drag = {
      type: 'scale',
      needsHistory: true,
      snap: E.snapshotShapes(shapes),
      anchor,
      startCorner: toWorld(corner.corner.x, corner.corner.y),
    };
    return;
  }

  const nh = hitNodeAt(px, py);
  if (nh) {
    if (e.shiftKey) E.selectNode(nh.sid, nh.ci, nh.ni, true);
    else if (!state.selection.nodes.has(nh.key)) E.selectNode(nh.sid, nh.ci, nh.ni, false);
    drag = { type: 'nodes', needsHistory: true, start: wp, snap: captureSelectedNodes() };
    return;
  }

  const hh = hitHandleAt(px, py);
  if (hh) {
    drag = { type: 'handle', needsHistory: true, ...hh, alt: e.altKey };
    return;
  }

  const sh = hitShapeAt(wp);
  if (sh) {
    if (e.shiftKey) E.selectShape(sh.shape.id, true);
    else if (!state.selection.shapes.has(sh.shape.id)) E.selectShape(sh.shape.id, false);
    drag = {
      type: 'shape',
      needsHistory: true,
      start: wp,
      snap: E.snapshotShapes(state.shapes.filter((s) => state.selection.shapes.has(s.id))),
    };
    return;
  }

  // 已选中对象：在选框内部（非线条处）按下也应拖动整块，而不是取消选择
  const selBox = G.shapesBBox(state.shapes.filter((s) => state.selection.shapes.has(s.id)));
  if (selBox && G.pointInRect(wp, selBox)) {
    drag = {
      type: 'shape',
      needsHistory: true,
      start: wp,
      snap: E.snapshotShapes(state.shapes.filter((s) => state.selection.shapes.has(s.id))),
    };
    return;
  }

  // 框选一律「替换」当前选择：不再用 Shift 追加。
  // 中文输入法切换中英文时常常按着 Shift，若 Shift+框选=追加，用户会莫名把左侧的字一起选上。
  // 需要加选请用 Shift 点选单个对象。
  E.selectShape(null, false);
  drag = { type: 'rubber', start: wp, additive: false, base: [] };
}

function captureSelectedNodes() {
  const out = [];
  for (const r of E.selectedNodeRefs()) {
    const n = r.contour.nodes[r.ni];
    out.push({
      sid: r.sid,
      ci: r.ci,
      ni: r.ni,
      x: n.x,
      y: n.y,
      in: n.in ? { ...n.in } : null,
      out: n.out ? { ...n.out } : null,
    });
  }
  return out;
}

function onPointerMove(e) {
  const { px, py } = localPos(e);
  const wp = toWorld(px, py);
  pointer.x = px;
  pointer.y = py;
  pointer.wx = wp.x;
  pointer.wy = wp.y;
  pointer.inside = true;

  if (!drag) {
    if (state.ui.tool === 'cut') {
      const t = hitCutTarget(wp);
      const next = t ? { type: 'cut', cut: t } : null;
      const changed = hoverKey(next) !== hoverKey(hover);
      hover = next;
      canvas.style.cursor = 'crosshair';
      if (changed) requestRender();
      emit('pointer');
      return;
    }
    const nh = hitNodeAt(px, py);
    const hh = nh ? null : hitHandleAt(px, py);
    const next = nh ? { type: 'node', key: nh.key } : hh ? { type: 'handle' } : null;
    const changed = hoverKey(next) !== hoverKey(hover);
    hover = next;
    const inSelBox = selBoxCache && G.pointInRect(wp, selBoxCache);
    canvas.style.cursor = spaceDown ? 'grab' : nh ? 'move' : hh ? 'crosshair' : inSelBox ? 'move' : 'default';
    if (changed) requestRender();
    emit('pointer');
    return;
  }

  if (drag.type === 'pan') {
    state.view.tx = drag.view.tx + (px - drag.start.x);
    state.view.ty = drag.view.ty + (py - drag.start.y);
  } else if (drag.type === 'nodes') {
    if (drag.needsHistory) { pushHistory(); drag.needsHistory = false; }
    const dx = wp.x - drag.start.x;
    const dy = wp.y - drag.start.y;
    for (const it of drag.snap) {
      const shape = state.shapes.find((s) => s.id === it.sid);
      if (!shape) continue;
      const n = shape.contours[it.ci] && shape.contours[it.ci].nodes[it.ni];
      if (!n) continue;
      n.x = it.x + dx;
      n.y = it.y + dy;
      n.in = it.in ? { x: it.in.x + dx, y: it.in.y + dy } : null;
      n.out = it.out ? { x: it.out.x + dx, y: it.out.y + dy } : null;
    }
  } else if (drag.type === 'shape') {
    if (drag.needsHistory) { pushHistory(); drag.needsHistory = false; }
    E.applyTranslateToShapes(drag.snap, wp.x - drag.start.x, wp.y - drag.start.y);
  } else if (drag.type === 'handle') {
    if (drag.needsHistory) { pushHistory(); drag.needsHistory = false; }
    const shape = state.shapes.find((s) => s.id === drag.sid);
    const n = shape && shape.contours[drag.ci] && shape.contours[drag.ci].nodes[drag.ni];
    if (n) {
      n[drag.which] = { x: wp.x, y: wp.y };
      if (!drag.alt) {
        const other = drag.which === 'in' ? 'out' : 'in';
        if (n[other]) n[other] = { x: 2 * n.x - wp.x, y: 2 * n.y - wp.y };
      }
    }
  } else if (drag.type === 'scale') {
    if (drag.needsHistory) { pushHistory(); drag.needsHistory = false; }
    let sx = (wp.x - drag.anchor.x) / (drag.startCorner.x - drag.anchor.x);
    let sy = (wp.y - drag.anchor.y) / (drag.startCorner.y - drag.anchor.y);
    if (!isFinite(sx)) sx = 1;
    if (!isFinite(sy)) sy = 1;
    if (e.shiftKey) {
      const m = Math.max(Math.abs(sx), Math.abs(sy));
      sx = Math.sign(sx || 1) * m;
      sy = Math.sign(sy || 1) * m;
    }
    const lim = 0.02;
    if (Math.abs(sx) < lim) sx = Math.sign(sx || 1) * lim;
    if (Math.abs(sy) < lim) sy = Math.sign(sy || 1) * lim;
    E.applyScaleToShapes(drag.snap, drag.anchor.x, drag.anchor.y, sx, sy);
  } else if (drag.type === 'rubber') {
    // 仅重绘
  }

  emit('pointer');
  requestRender();
}

function onPointerUp(e) {
  if (!drag) return;
  const { px, py } = localPos(e);

  if (drag.type === 'rubber') {
    const a = toScreen(drag.start.x, drag.start.y);
    const b = { x: px, y: py };
    const rect = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
    if (rect.w > 3 || rect.h > 3) {
      const ids = drag.additive ? [...drag.base] : [];
      for (const { shape, box } of hitEntries()) {
        if (!box) continue;
        const s0 = toScreen(box.x, box.y);
        const s1 = toScreen(box.x + box.w, box.y + box.h);
        if (G.bboxIntersects(rect, { x: s0.x, y: s0.y, w: s1.x - s0.x, h: s1.y - s0.y })) ids.push(shape.id);
      }
      E.selectShapes(ids, false);
    }
  }

  drag = null;
  canvas.classList.remove('panning');
  canvas.style.cursor = spaceDown ? 'grab' : 'default';
  emit('edit');
  requestRender();
}

function onDblClick(e) {
  if (state.ui.tool === 'cut') return;
  const { px, py } = localPos(e);
  const wp = toWorld(px, py);
  const tol = 8 / state.view.scale;
  let best = null;
  for (const { shape, box } of hitEntries()) {
    if (!boxContains(box, wp.x, wp.y, tol)) continue;
    const h = G.hitShape(shape, wp, tol);
    if (h && (!best || h.dist < best.hit.dist)) best = { shape, hit: h };
  }
  if (best) {
    const ok = E.insertNodeAtHit(best.shape.id, best.hit.ci, best.hit.si, best.hit.t);
    toast(ok ? '已在线段中点插入节点' : '该线段无法插入节点', ok ? 'ok' : 'err');
    return;
  }
  if (blankDblClickHandler) blankDblClickHandler({ px, py, x: wp.x, y: wp.y });
}

/** 双击空白画布时由 UI 层弹出文字输入框 */
/**
 * 把当前画布内容渲染成方形缩略图（PNG dataURL），用于作品库列表。
 * 用独立的离屏 canvas，不依赖主画布的缩放与视口。
 */
export function renderThumbnail(size = 160) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, size, size);

  const box = G.shapesBBox(state.shapes);
  if (!box || box.w <= 0 || box.h <= 0) return cv.toDataURL('image/png');

  const pad = size * 0.07;
  const s = Math.min((size - pad * 2) / box.w, (size - pad * 2) / box.h);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(s, s);
  ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
  ctx.strokeStyle = '#c8d2e4';
  ctx.lineWidth = 1.3 / s;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const shape of state.shapes) {
    const d = G.shapeToPathData(shape);
    if (d) ctx.stroke(new Path2D(d));
  }
  ctx.restore();
  return cv.toDataURL('image/png');
}

export function setBlankDblClickHandler(fn) {
  blankDblClickHandler = fn;
}

function onWheel(e) {
  e.preventDefault();
  const { px, py } = localPos(e);
  if (e.shiftKey) {
    // Shift+滚轮平移；触控板双指捏合会以 Ctrl+wheel 到达，因此 Ctrl 不再占用平移
    state.view.tx -= e.deltaX || e.deltaY;
  } else {
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(px, py, factor);
  }
  requestRender();
  emit('zoom');
}

// ---------------------------------------------------------------- 视图操作

export function zoomAt(px, py, factor) {
  const v = state.view;
  const next = G.clamp(v.scale * factor, 0.02, 64);
  const k = next / v.scale;
  v.tx = px - (px - v.tx) * k;
  v.ty = py - (py - v.ty) * k;
  v.scale = next;
  emit('zoom');
}

export function zoomBy(factor) {
  zoomAt(W / 2, H / 2, factor);
  requestRender();
}

export function fitView(padding = 70) {
  const shapes = state.shapes;
  if (!shapes.length) {
    state.view.scale = 1;
    state.view.tx = W / 2;
    state.view.ty = H / 2;
    requestRender();
    emit('zoom');
    return;
  }
  const box = G.shapesBBox(shapes);
  if (!box) return;
  // 退化包围盒（纯水平/垂直笔画）也要能适应窗口
  const w = Math.max(box.w, 1e-6);
  const h = Math.max(box.h, 1e-6);
  const s = Math.min((W - padding * 2) / w, (H - padding * 2) / h, 8);
  state.view.scale = Math.max(0.02, s);
  state.view.tx = W / 2 - (box.x + box.w / 2) * state.view.scale;
  state.view.ty = H / 2 - (box.y + box.h / 2) * state.view.scale;
  requestRender();
  emit('zoom');
}

/** 切换工具（select / cut） */
export function setTool(tool) {
  state.ui.tool = tool;
  hover = null;
  if (canvas) canvas.style.cursor = tool === 'cut' ? 'crosshair' : 'default';
  requestRender();
  emit('tool');
}
