// 文档级编辑操作：选择、切断、连接、闭合、删除、插入、反向。
// 每个会改变文档的操作都会先 pushHistory()，因此撤销/重做天然覆盖全部编辑动作。

import * as G from './geometry.js';
import { state, pushHistory, clearSelection, selectedShapes, findShape, emit, nextShapeId } from './state.js';

// ---------------------------------------------------------------- 选择

export function selectShape(id, additive = false) {
  if (!additive) {
    clearSelection();
    if (id) state.selection.shapes.add(id);
  } else if (id) {
    if (state.selection.shapes.has(id)) state.selection.shapes.delete(id);
    else state.selection.shapes.add(id);
  }
  emit('selection');
}

export function selectShapes(ids, additive = false) {
  if (!additive) clearSelection();
  for (const id of ids) state.selection.shapes.add(id);
  emit('selection');
}

export function selectNode(sid, ci, ni, additive = false) {
  const key = G.nodeKey(sid, ci, ni);
  if (!additive) {
    clearSelection();
    state.selection.shapes.add(sid);
    state.selection.nodes.add(key);
  } else if (state.selection.nodes.has(key)) {
    state.selection.nodes.delete(key);
  } else {
    state.selection.shapes.add(sid);
    state.selection.nodes.add(key);
  }
  emit('selection');
}

export function selectNodes(refs, additive = false) {
  if (!additive) clearSelection();
  for (const r of refs) {
    state.selection.shapes.add(r.sid);
    state.selection.nodes.add(G.nodeKey(r.sid, r.ci, r.ni));
  }
  emit('selection');
}

export function selectedNodeRefs() {
  const out = [];
  for (const key of state.selection.nodes) {
    const { sid, ci, ni } = G.parseNodeKey(key);
    const shape = findShape(sid);
    if (!shape || !shape.contours[ci] || !shape.contours[ci].nodes[ni]) continue;
    out.push({ sid, ci, ni, shape, contour: shape.contours[ci] });
  }
  return out;
}

export function selectAll() {
  clearSelection();
  for (const s of state.shapes) state.selection.shapes.add(s.id);
  emit('selection');
}

// ---------------------------------------------------------------- 删除

export function deleteSelection() {
  const refs = selectedNodeRefs();
  if (refs.length) {
    pushHistory();
    // 按轮廓分组；同一 shape 内按 ci 降序处理，避免 splice 造成下标错位
    const groups = new Map();
    for (const r of refs) {
      const key = `${r.sid}|${r.ci}`;
      if (!groups.has(key)) groups.set(key, { sid: r.sid, ci: r.ci, idx: [] });
      groups.get(key).idx.push(r.ni);
    }
    const ordered = [...groups.values()].sort((a, b) =>
      a.sid === b.sid ? b.ci - a.ci : a.sid.localeCompare(b.sid)
    );
    for (const g of ordered) {
      const shape = findShape(g.sid);
      if (!shape) continue;
      const contour = shape.contours[g.ci];
      if (!contour) continue;
      let current = contour;
      for (const ni of g.idx.sort((a, b) => b - a)) {
        const next = G.removeNodeAt(current, ni);
        if (next === null) {
          current = null;
          break;
        }
        current = next;
      }
      if (current) shape.contours[g.ci] = current;
      else shape.contours.splice(g.ci, 1);
    }
    state.shapes = state.shapes.filter((s) => s.contours.length > 0);
    clearSelection();
    emit('edit');
    return { ok: true, msg: `已删除 ${refs.length} 个节点` };
  }

  if (state.selection.shapes.size) {
    const n = state.selection.shapes.size;
    pushHistory();
    state.shapes = state.shapes.filter((s) => !state.selection.shapes.has(s.id));
    clearSelection();
    emit('edit');
    return { ok: true, msg: `已删除 ${n} 条路径` };
  }
  return { ok: false, msg: '没有可删除的对象' };
}

// ---------------------------------------------------------------- 连接

export function joinSelectedEndpoints() {
  const refs = selectedNodeRefs();
  if (refs.length !== 2) return { ok: false, msg: '请选中两个端点（Shift 加选）' };

  const [r1, r2] = refs;
  const role1 = G.nodeRole(r1.contour, r1.ni);
  const role2 = G.nodeRole(r2.contour, r2.ni);
  if (role1 !== 'start' && role1 !== 'end') return { ok: false, msg: '第一个选中节点不是端点' };
  if (role2 !== 'start' && role2 !== 'end') return { ok: false, msg: '第二个选中节点不是端点' };

  const same = r1.sid === r2.sid && r1.ci === r2.ci;

  if (same) {
    if (role1 === role2) {
      return { ok: false, msg: '同一条轮廓需选中首尾两个端点' };
    }
    const closed = G.closeContour(r1.contour);
    if (!closed) return { ok: false, msg: '闭合失败（节点不足）' };
    pushHistory();
    r1.shape.contours[r1.ci] = closed;
    clearSelection();
    emit('edit');
    return { ok: true, msg: '已闭合成环' };
  }

  const joined = G.joinContours(r1.contour, role1, r2.contour, role2, false);
  pushHistory();
  r1.shape.contours[r1.ci] = joined;
  r2.shape.contours.splice(r2.ci, 1);
  if (!r2.shape.contours.length) {
    state.shapes = state.shapes.filter((s) => s.id !== r2.shape.id);
  }
  clearSelection();
  emit('edit');
  return { ok: true, msg: '已连接为一条路径' };
}

// ---------------------------------------------------------------- 闭合

export function closeSelectedContours(mode = 'line') {
  const refs = selectedNodeRefs();
  const targets = [];
  if (refs.length) {
    const seen = new Set();
    for (const r of refs) {
      const key = `${r.sid}|${r.ci}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ sid: r.sid, ci: r.ci });
    }
  } else {
    for (const s of selectedShapes()) s.contours.forEach((_, ci) => targets.push({ sid: s.id, ci }));
  }
  if (!targets.length) return { ok: false, msg: '请先选中路径或节点' };

  // 先算出所有可闭合结果（closeContourWith 不修改原对象），确认有变化再入历史
  const results = [];
  for (const t of targets) {
    const shape = findShape(t.sid);
    if (!shape) continue;
    const c = shape.contours[t.ci];
    if (!c || c.closed) continue;
    const closed = G.closeContourWith(c, mode);
    if (closed) results.push({ shape, ci: t.ci, closed });
  }
  if (!results.length) return { ok: false, msg: '没有可闭合的开放轮廓' };

  pushHistory();
  for (const r of results) r.shape.contours[r.ci] = r.closed;
  clearSelection();
  emit('edit');
  return { ok: true, msg: `已用${mode === 'arc' ? '圆弧' : '直线'}闭合 ${results.length} 条轮廓` };
}

// ---------------------------------------------------------------- 插入节点

export function insertNodeAfterSelected() {
  const refs = selectedNodeRefs();
  if (!refs.length) return { ok: false, msg: '请先选中一个节点（在其相邻线段中点插入）' };
  const usable = refs.filter((r) => r.contour.nodes.length >= 2);
  if (!usable.length) return { ok: false, msg: '插入失败（节点不足）' };

  pushHistory();
  let n = 0;
  for (const r of usable) {
    const c = r.contour;
    const len = c.nodes.length;
    let si = r.ni;
    // 末尾节点（开放轮廓）没有后继线段，改为在其前一段插入
    if (!c.closed && si >= len - 1) si = len - 2;
    if (G.insertNodeAt(c, si, 0.5)) n += 1;
  }
  if (!n) return { ok: false, msg: '插入失败' };
  emit('edit');
  return { ok: true, msg: `已插入 ${n} 个节点（线段中点）` };
}

export function insertNodeAtHit(sid, ci, si, t) {
  const shape = findShape(sid);
  if (!shape) return false;
  const c = shape.contours[ci];
  if (!c || c.nodes.length < 2) return false;
  if (!Number.isInteger(si) || si < 0 || si >= c.nodes.length || typeof t !== 'number' || !Number.isFinite(t)) {
    return false;
  }

  // 先在副本上插入，确认成功后再入历史，避免失败时留下空撤销步
  const work = G.cloneContour(c);
  if (!G.insertNodeAt(work, si, t)) return false;
  pushHistory();
  shape.contours[ci] = work;
  clearSelection();
  state.selection.shapes.add(sid);
  const ni = si + 1;
  state.selection.nodes.add(G.nodeKey(sid, ci, ni));
  emit('edit');
  return true;
}

// ---------------------------------------------------------------- 点切断（工具模式）

/**
 * 在指定位置切断某条路径。
 * @param {string} sid 路径 id
 * @param {{ni?:number, si?:number, t?:number}} at 顶点索引；或线段索引 + 参数（先插入节点再切）
 */
export function cutAt(sid, at) {
  const shape = findShape(sid);
  if (!shape) return { ok: false, msg: '路径不存在' };
  const c = shape.contours[0];
  if (!c) return { ok: false, msg: '路径为空' };

  // 在副本上完成“插入节点 + 切断”，成功后再入历史；失败不会弄脏文档/撤销栈
  const work = G.cloneContour(c);
  let cutIndex = typeof at.ni === 'number' ? at.ni : -1;
  if (cutIndex < 0) {
    if (
      !Number.isInteger(at.si) ||
      at.si < 0 ||
      at.si >= work.nodes.length ||
      typeof at.t !== 'number' ||
      !Number.isFinite(at.t)
    ) {
      return { ok: false, msg: '切断位置无效' };
    }
    if (!G.insertNodeAt(work, at.si, at.t)) return { ok: false, msg: '无法在该位置插入节点' };
    cutIndex = at.si + 1;
  }
  if (!Number.isInteger(cutIndex) || cutIndex < 0 || cutIndex >= work.nodes.length) {
    return { ok: false, msg: '切断位置无效' };
  }

  const parts = G.splitContourAt(work, cutIndex);
  if (!parts) return { ok: false, msg: '该位置是端点，无需切断' };

  // 一条路径拆分后变成多条路径（保持「一条路径 = 一个独立部分」的模型）
  pushHistory();
  const idx = state.shapes.indexOf(shape);
  const created = parts.map((p) => ({ ...shape, id: nextShapeId(), contours: [p] }));
  state.shapes.splice(idx, 1, ...created);
  clearSelection();
  emit('edit');
  return { ok: true, msg: parts.length > 1 ? '已切断为两段' : '已断开为开口路径' };
}

// ---------------------------------------------------------------- 笔画库

/**
 * 取某个轮廓所属字符的字身框，并按「字符当前墨迹」重新锚定。
 * 旧工程里的框是按转换时的位置算的，之后字被拖动、框不会自动跟随，
 * 直接用会导致笔画落在框外（预览空白、导出位置错）。这里用记录墨迹与当前墨迹的
 * 位移把框平移过去；没有墨迹记录时原样返回（上层还有并集兜底）。
 */
function cellForPart(part) {
  const cell = part.cellKey ? state.charCells[part.cellKey] : null;
  if (!cell) return null;
  const out = { ...cell };
  if (!cell.ink) return out;

  let ink = null;
  for (const s of state.shapes) {
    if (s.cellKey !== part.cellKey) continue;
    const b = G.shapeBBox(s);
    if (b) ink = ink ? G.unionBBox(ink, b) : b;
  }
  if (!ink) return out;
  out.x += ink.x + ink.w / 2 - (cell.ink.x + cell.ink.w / 2);
  out.y += ink.y + ink.h / 2 - (cell.ink.y + cell.ink.h / 2);
  return out;
}
export function nextStrokeId() {
  const used = new Set(state.strokes.map((s) => s.id));
  let id = `k${state.nextStrokeId++}`;
  while (used.has(id)) id = `k${state.nextStrokeId++}`;
  return id;
}

/**
 * 把选中的闭合路径加入笔画列表（快照复制，与画布解耦）。
 * 开放路径会被跳过，并给出提示。
 */
export function addStrokesFromSelection(opts = {}) {
  const parts = selectedShapes();
  if (!parts.length) return { ok: false, msg: '请先选中路径' };

  // 多个选中路径合并为同一个笔画：contours 数组里放多条轮廓
  const contours = [];
  const examples = new Set();
  let skipped = 0;
  for (const p of parts) {
    let added = false;
    for (const c of p.contours) {
      if (c.closed && c.nodes.length >= 3) {
        contours.push(G.cloneContour(c));
        added = true;
      }
    }
    if (added && p.ch) examples.add(p.ch);
    if (!added) skipped += 1;
  }
  if (!contours.length) return { ok: false, msg: '只能把闭合路径加入笔画列表' };

  // 部首模式：记录字身框，导出时按整字位置映射；否则 frame = null（按单笔包围盒居中放大）
  const useCell = opts.useCell !== undefined ? !!opts.useCell : !!state.ui.radicalMode;
  let frame = null;
  if (useCell) {
    let box = null;
    for (const p of parts) {
      const cell = cellForPart(p);
      if (!cell) continue;
      box = box ? G.unionBBox(box, cell) : cell;
    }
    if (!box) return { ok: false, msg: '当前路径缺少字身框信息，请重新转换文字后再试' };
    frame = box;
  }

  pushHistory();
  state.strokes.push({
    id: nextStrokeId(),
    name: `${useCell ? '部首' : '笔画'} ${state.strokes.length + 1}`,
    example: [...examples].join(''),
    contours,
    frame,
  });
  emit('strokes');
  return {
    ok: true,
    msg: `已添加 1 个${useCell ? '部首（按整字位置）' : '笔画'}（${contours.length} 条轮廓）${skipped ? `，跳过 ${skipped} 条开放路径` : ''}`,
  };
}

export function removeStroke(id) {
  const i = state.strokes.findIndex((s) => s.id === id);
  if (i < 0) return;
  pushHistory();
  state.strokes.splice(i, 1);
  emit('strokes');
}

/** 用当前选中的全部闭合轮廓覆盖某条笔画的几何（保持名称/例字不变） */
export function updateStrokeGeometry(id) {
  const stroke = state.strokes.find((s) => s.id === id);
  if (!stroke) return { ok: false, msg: '笔画不存在' };

  const contours = [];
  for (const s of selectedShapes()) {
    for (const c of s.contours) {
      if (c.closed && c.nodes.length >= 3) contours.push(G.cloneContour(c));
    }
  }
  if (!contours.length) return { ok: false, msg: '请先选中至少一条闭合路径' };

  pushHistory();
  stroke.contours = contours;
  emit('strokes');
  return { ok: true, msg: `已用 ${contours.length} 条选中轮廓更新「${stroke.name}」` };
}

// ---------------------------------------------------------------- 变换（拖拽缩放用）

/**
 * 字身框跟随：只有当一个字符的**全部**轮廓都在本次变换里时，才同步它的字身框。
 * 只动其中一部分时字身框保持不动——这正是「笔画在字中的位置发生改变」的语义。
 */
function syncCharCells(movedIds, transformPoint) {
  const cells = state.charCells;
  if (!cells) return;
  const groups = new Map();
  for (const s of state.shapes) {
    if (!s.cellKey || !cells[s.cellKey]) continue;
    const rec = groups.get(s.cellKey) || { total: 0, moved: 0 };
    rec.total += 1;
    if (movedIds.has(s.id)) rec.moved += 1;
    groups.set(s.cellKey, rec);
  }
  for (const [key, rec] of groups) {
    if (rec.moved > 0 && rec.moved === rec.total) {
      const next = G.transformBox(cells[key], transformPoint);
      // 记录墨迹也要跟着变换，否则「重新锚定」会用到过期的墨迹
      if (cells[key].ink) next.ink = G.transformBox(cells[key].ink, transformPoint);
      cells[key] = next;
    }
  }
}

export function applyScaleToShapes(snapshot, ox, oy, sx, sy) {
  for (const item of snapshot) {
    const shape = findShape(item.id);
    if (!shape) continue;
    item.contours.forEach((orig, ci) => {
      const target = shape.contours[ci];
      if (!target) return;
      target.nodes.forEach((n, ni) => {
        const o = orig[ni];
        if (!o) return;
        n.x = ox + (o.x - ox) * sx;
        n.y = oy + (o.y - oy) * sy;
        if (o.in) n.in = { x: ox + (o.in.x - ox) * sx, y: oy + (o.in.y - oy) * sy };
        else n.in = null;
        if (o.out) n.out = { x: ox + (o.out.x - ox) * sx, y: oy + (o.out.y - oy) * sy };
        else n.out = null;
      });
    });
  }
  syncCharCells(new Set(snapshot.map((i) => i.id)), (p) => ({
    x: ox + (p.x - ox) * sx,
    y: oy + (p.y - oy) * sy,
  }));
}

export function applyTranslateToShapes(snapshot, dx, dy) {
  for (const item of snapshot) {
    const shape = findShape(item.id);
    if (!shape) continue;
    item.contours.forEach((orig, ci) => {
      const target = shape.contours[ci];
      if (!target) return;
      target.nodes.forEach((n, ni) => {
        const o = orig[ni];
        if (!o) return;
        n.x = o.x + dx;
        n.y = o.y + dy;
        n.in = o.in ? { x: o.in.x + dx, y: o.in.y + dy } : null;
        n.out = o.out ? { x: o.out.x + dx, y: o.out.y + dy } : null;
      });
    });
  }
  syncCharCells(new Set(snapshot.map((i) => i.id)), (p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function snapshotShapes(shapes) {
  return shapes.map((s) => ({
    id: s.id,
    contours: s.contours.map((c) => c.nodes.map(G.cloneNode)),
  }));
}
