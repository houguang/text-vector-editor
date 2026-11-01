// SVG 导出：固定 viewBox="0 0 1000 1000"，只输出描边线条（fill="none" stroke="#000"）。
// - 画布导出：选中 / 全部
// - 笔画库批量导出：一个笔画一个文件，文件名取笔画名称
//
// 坐标处理：每次导出都以「本次要导出的内容包围盒」为参考框：
// 等比放大到 1000×1000 内（四周留 50 单位边距）并居中，变换直接烘焙进 path 坐标。
// 因此单个笔画/选中路径不会因为画布上其他内容离得远而缩成一小团，小笔画也会被放大。

import * as G from './geometry.js';
import { state, selectedShapes, toast, setExportDir, clearExportDir } from './state.js';
import { invoke, isTauri } from './api.js';

const SIZE = 1000;
const MARGIN = 50;
/** 字身框导出时的安全余量（比例）：字体墨迹偶尔略微超出 em 框，留一点避免被裁 */
const CELL_SAFE = 0.02;

/** XML 文本转义：title 来自用户可编辑的笔画名，必须转义后再拼进 SVG */
const xmlText = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** 由参考框算出「缩放到 1000×1000 并居中」的变换；margin=0 表示参考框正好铺满画布 */
function makeFrame(box, margin = MARGIN) {
  const avail = SIZE - margin * 2;
  // 退化包围盒（纯水平/垂直线）用 1 参与求缩放，但用真实宽高计算居中偏移
  const w = box.w > 1e-9 ? box.w : 1;
  const h = box.h > 1e-9 ? box.h : 1;
  const s = Math.min(avail / w, avail / h);
  return {
    s,
    tx: (SIZE - box.w * s) / 2 - box.x * s,
    ty: (SIZE - box.h * s) / 2 - box.y * s,
  };
}

const applyFrame = (frame, p) => ({ x: p.x * frame.s + frame.tx, y: p.y * frame.s + frame.ty });

function wrap(body, title) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `  <title>${xmlText(title)}</title>`,
    body,
    '</svg>',
    '',
  ].join('\n');
}

const STROKE_ATTRS = 'fill="none" stroke="#000000" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"';

/** 多路径导出（画布选中 / 全部） */
export function buildSVG(shapes, title = 'GlyphCut export') {
  if (!shapes.length) return null;
  const box = G.shapesBBox(shapes);
  if (!box) return null;
  const frame = makeFrame(box);

  const body = shapes
    .map((s) => {
      const parts = s.contours
        .map((c) => G.contourToPathData(G.transformContour(c, (p) => applyFrame(frame, p))))
        .filter(Boolean);
      return parts.length ? `  <path d="${parts.join(' ')}" ${STROKE_ATTRS} />` : '';
    })
    .filter(Boolean)
    .join('\n');

  if (!body) return null;
  return wrap(body, title);
}

/**
 * 一个笔画（可含多条轮廓）。
 * - frame 为空：按自身包围盒居中放大到 900×900（基本笔画，每个都铺满便于做范本）
 * - frame 有值（字身框）：把字身框铺满整个 1000×1000，笔画保留在字中的位置与相对大小（部首）
 */
export function buildStrokeSVG(contours, title = 'stroke', frame = null) {
  const list = (contours || []).filter(Boolean);
  if (!list.length) return null;

  let box = null;
  for (const c of list) {
    const b = G.contourBBox(c);
    if (b) box = box ? G.unionBBox(box, b) : b;
  }
  if (!box || (box.w <= 1e-9 && box.h <= 1e-9)) return null;

  // 字身框若与墨迹错位（旧数据），取并集，避免导出后笔画落在画布外
  const fr = frame ? makeFrame(G.unionBBox(frame, box), SIZE * CELL_SAFE) : makeFrame(box);
  const parts = list
    .map((c) => G.contourToPathData(G.transformContour(c, (p) => applyFrame(fr, p))))
    .filter(Boolean);
  if (!parts.length) return null;
  return wrap(`  <path d="${parts.join(' ')}" ${STROKE_ATTRS} />`, title);
}

/** 兼容单轮廓调用（测试与旧调用） */
export function buildContourSVG(contour, title = 'stroke', frame = null) {
  return buildStrokeSVG(contour ? [contour] : [], title, frame);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * @param {'selected'|'all'} which
 */
export async function exportShapes(which) {
  const shapes = which === 'selected' ? selectedShapes() : state.shapes;
  if (!shapes.length) {
    toast(which === 'selected' ? '没有选中任何路径，请先框选或单击选中' : '画布上没有可导出的路径', 'err');
    return;
  }
  const valid = shapes.filter((s) => s.contours.some((c) => c.nodes.length > 1));
  if (!valid.length) {
    toast('选中对象的路径数据为空（节点不足 2 个），无法导出', 'err');
    return;
  }
  const svg = buildSVG(valid, which === 'selected' ? 'selection' : 'all');
  if (!svg) {
    toast('路径包围盒为空，无法导出', 'err');
    return;
  }

  const name = `glyphcut-${which === 'selected' ? 'selection' : 'all'}-${stamp()}.svg`;
  try {
    const res = await invoke('save_svg', { svg, defaultName: name });
    if (res) toast(`已导出 ${valid.length} 条路径 → ${res}`, 'ok');
    else toast('已取消导出');
  } catch (err) {
    toast(`导出失败：${err && err.message ? err.message : err}`, 'err');
  }
}

/** 批量导出笔画库：每个笔画一个 SVG，各自居中并放大，文件名 = 笔画名称 */
export async function exportStrokes() {
  if (!state.strokes.length) {
    toast('笔画列表为空，请先添加笔画', 'err');
    return;
  }

  const files = [];
  let skipped = 0;
  for (const s of state.strokes) {
    const svg = buildStrokeSVG(s.contours || (s.contour ? [s.contour] : []), s.name || 'stroke', s.frame || null);
    if (!svg) {
      skipped += 1;
      continue;
    }
    files.push({ name: (s.name || 'stroke').trim() || 'stroke', content: svg });
  }
  if (!files.length) {
    toast('笔画数据为空，无法导出', 'err');
    return;
  }
  try {
    let res = null;
    // 已经选过目录且当前在 Tauri 中：直接写入，不再弹选择框
    if (isTauri && state.exportDir) {
      try {
        res = await invoke('save_svgs_to', { files, folder: state.exportDir });
      } catch (err) {
        // 目录被删除/移动/无权限时清除记忆，退回一次目录选择
        clearExportDir();
        toast('原导出目录不可用，请重新选择目录', 'err');
      }
    }
    if (!res) {
      res = await invoke('save_svgs_dialog', { files });
      if (!res) {
        toast('已取消导出');
        return;
      }
      if (isTauri) setExportDir(res.folder);
    }
    toast(`已导出 ${res.count} 个 SVG（1000×1000）到 ${res.folder}${skipped ? `（跳过 ${skipped} 个空笔画）` : ''}`, 'ok');
  } catch (err) {
    toast(`批量导出失败：${err && err.message ? err.message : err}`, 'err');
  }
}
