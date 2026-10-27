// 几何核心：路径数据、包围盒、采样、命中测试与节点级编辑原语。
// 所有函数均为纯函数或就地修改传入的 contour 对象，不依赖 DOM / Tauri。

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const round = (v, p = 3) => {
  const m = 10 ** p;
  return Math.round(v * m) / m;
};

export const nodeKey = (sid, ci, ni) => `${sid}|${ci}|${ni}`;
export function parseNodeKey(key) {
  const p = key.split('|');
  return { sid: p[0], ci: Number(p[1]), ni: Number(p[2]) };
}

export function cloneNode(n) {
  return {
    x: n.x,
    y: n.y,
    in: n.in ? { x: n.in.x, y: n.in.y } : null,
    out: n.out ? { x: n.out.x, y: n.out.y } : null,
  };
}

export function cloneContour(c) {
  return { closed: !!c.closed, nodes: c.nodes.map(cloneNode) };
}

export function cloneShape(s) {
  return {
    ...s,
    contours: s.contours.map(cloneContour),
  };
}

/** 后端返回的 outline 数据 → 前端路径对象 */
export function shapeFromOutline(raw, id) {
  return {
    id,
    ch: raw.ch,
    line: raw.line,
    charIndex: raw.charIndex,
    advance: raw.advance,
    visible: true,
    bbox: raw.bbox,
    contours: (raw.contours || []).map((c) => ({
      closed: !!c.closed,
      nodes: (c.nodes || []).map((n) => ({
        x: n.x,
        y: n.y,
        in: n.in ? { x: n.in.x, y: n.in.y } : null,
        out: n.out ? { x: n.out.x, y: n.out.y } : null,
      })),
    })),
  };
}

// ---------------------------------------------------------------- 路径序列化

/**
 * 轮廓 → SVG path d。直线段输出 L，曲线段输出 C（控制点缺失时退化为端点）。
 */
export function contourToPathData(c, precision = 3) {
  const n = c.nodes;
  if (!n || n.length === 0) return '';
  const r = (v) => round(v, precision);
  if (n.length === 1) return `M ${r(n[0].x)} ${r(n[0].y)}`;

  let d = `M ${r(n[0].x)} ${r(n[0].y)}`;
  const seg = (a, b) => {
    if (!a.out && !b.in) return ` L ${r(b.x)} ${r(b.y)}`;
    const c1 = a.out || a;
    const c2 = b.in || b;
    return ` C ${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(b.x)} ${r(b.y)}`;
  };
  for (let i = 0; i < n.length - 1; i++) d += seg(n[i], n[i + 1]);
  if (c.closed) d += seg(n[n.length - 1], n[0]) + ' Z';
  return d;
}

export function shapeToPathData(shape) {
  return shape.contours.map((c) => contourToPathData(c)).filter(Boolean).join(' ');
}

/** 轮廓 → 线段列表（闭合轮廓最后一段回到首节点） */
export function contourSegments(c) {
  const n = c.nodes;
  const out = [];
  for (let i = 0; i < n.length - 1; i++) out.push({ a: n[i], b: n[i + 1], si: i });
  if (c.closed && n.length > 1) out.push({ a: n[n.length - 1], b: n[0], si: n.length - 1 });
  return out;
}

export function cubicAt(p0, c1, c2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const cc = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + cc * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + cc * c2.y + d * p3.y,
  };
}

export function segmentSamples(a, b, steps = 12) {
  const isCurve = !!(a.out || b.in);
  const pts = [];
  if (!isCurve) {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return pts;
  }
  const c1 = a.out || a;
  const c2 = b.in || b;
  for (let i = 0; i <= steps; i++) pts.push(cubicAt(a, c1, c2, b, i / steps));
  return pts;
}

// ---------------------------------------------------------------- 包围盒

export function contourBBox(c, steps = 10) {
  const n = c.nodes;
  if (!n || !n.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const s of contourSegments(c)) {
    for (const p of segmentSamples(s.a, s.b, steps)) add(p.x, p.y);
  }
  if (n.length === 1) add(n[0].x, n[0].y);
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function shapeBBox(shape) {
  let box = null;
  for (const c of shape.contours) {
    const b = contourBBox(c);
    if (!b) continue;
    box = box ? unionBBox(box, b) : b;
  }
  return box;
}

export function unionBBox(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

export function shapesBBox(shapes) {
  let box = null;
  for (const s of shapes) {
    const b = shapeBBox(s);
    if (b) box = box ? unionBBox(box, b) : b;
  }
  return box;
}

export function bboxIntersects(a, b) {
  if (!a || !b) return false;
  return !(a.x > b.x + b.w || a.x + a.w < b.x || a.y > b.y + b.h || a.y + a.h < b.y);
}

// ---------------------------------------------------------------- 命中测试

export function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : clamp((wx * vx + wy * vy) / len, 0, 1);
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return Math.hypot(dx, dy);
}

/** 线段参数 t 处的点 */
export function pointOnSegment(a, b, t) {
  if (!a.out && !b.in) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return cubicAt(a, a.out || a, b.in || b, b, t);
}

/** 在 t0 附近三分法细化，求点到线段最近点的参数 */
function refineT(a, b, pt, t0, radius = 0.12) {
  let lo = Math.max(0, t0 - radius);
  let hi = Math.min(1, t0 + radius);
  const d2 = (t) => {
    const p = pointOnSegment(a, b, t);
    return (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
  };
  for (let k = 0; k < 14; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (d2(m1) < d2(m2)) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

/** 命中轮廓，返回最近线段 { ci, si, t, dist } */
export function hitContour(c, ci, pt, tol) {
  let best = null;
  for (const s of contourSegments(c)) {
    const pts = segmentSamples(s.a, s.b, 20);
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distToSegment(pt.x, pt.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (d <= tol && (!best || d < best.dist)) {
        const t0 = (i + 0.5) / (pts.length - 1);
        const t = refineT(s.a, s.b, pt, t0);
        const p = pointOnSegment(s.a, s.b, t);
        const exact = Math.hypot(p.x - pt.x, p.y - pt.y);
        best = { ci, si: s.si, dist: exact, t, x: p.x, y: p.y };
      }
    }
  }
  return best;
}

export function hitShape(shape, pt, tol) {
  let best = null;
  shape.contours.forEach((c, ci) => {
    const h = hitContour(c, ci, pt, tol);
    if (h && (!best || h.dist < best.dist)) best = h;
  });
  return best;
}

export function pointInRect(pt, rect) {
  return pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
}

// ---------------------------------------------------------------- 节点编辑原语

/** 直线/曲线段在参数 t 处插入节点（de Casteljau 精确分割） */
export function insertNodeAt(contour, si, t) {
  const n = contour.nodes;
  if (n.length < 2) return false;
  if (!Number.isInteger(si) || si < 0 || si >= n.length) return false;
  if (!contour.closed && si >= n.length - 1) return false;
  if (typeof t !== 'number' || !Number.isFinite(t)) return false;
  const a = n[si];
  const b = n[(si + 1) % n.length];
  const tt = clamp(t, 0.001, 0.999);
  if (!a.out && !b.in) {
    const p = { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt };
    n.splice(si + 1, 0, { x: p.x, y: p.y, in: null, out: null });
    return true;
  }
  const c1 = a.out || a;
  const c2 = b.in || b;
  const lerp = (p, q, u) => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
  const p01 = lerp(a, c1, tt);
  const p12 = lerp(c1, c2, tt);
  const p23 = lerp(c2, b, tt);
  const p012 = lerp(p01, p12, tt);
  const p123 = lerp(p12, p23, tt);
  const p = lerp(p012, p123, tt);
  a.out = p01;
  b.in = p23;
  n.splice(si + 1, 0, { x: p.x, y: p.y, in: p012, out: p123 });
  return true;
}

/**
 * 在节点 ni 处切断。
 * - 闭合轮廓：断开为一条开放轮廓（首尾同点），节点数 +1
 * - 开放轮廓：拆成两条开放轮廓
 * 返回新的轮廓数组；无法切断时返回 null。
 */
export function splitContourAt(contour, ni) {
  const n = contour.nodes;
  if (!Number.isInteger(ni) || ni < 0 || ni >= n.length) return null;
  if (contour.closed) {
    if (n.length < 3) return null;
    const ordered = [...n.slice(ni), ...n.slice(0, ni)];
    const start = { x: ordered[0].x, y: ordered[0].y, in: null, out: ordered[0].out ? { ...ordered[0].out } : null };
    const end = { x: ordered[0].x, y: ordered[0].y, in: ordered[0].in ? { ...ordered[0].in } : null, out: null };
    const mid = ordered.slice(1).map(cloneNode);
    return [{ closed: false, nodes: [start, ...mid, end] }];
  }
  if (ni <= 0 || ni >= n.length - 1) return null;
  const a = { closed: false, nodes: n.slice(0, ni + 1).map(cloneNode) };
  const b = { closed: false, nodes: n.slice(ni).map(cloneNode) };
  a.nodes[a.nodes.length - 1].out = null;
  b.nodes[0].in = null;
  return [a, b];
}

export function reverseContour(c) {
  const nodes = c.nodes
    .slice()
    .reverse()
    .map((n) => ({
      x: n.x,
      y: n.y,
      in: n.out ? { ...n.out } : null,
      out: n.in ? { ...n.in } : null,
    }));
  return { closed: c.closed, nodes };
}

/**
 * 计算闭合处的平滑连接控制柄：出柄沿 from 的来向切线，入柄沿 to 的去向切线，
 * 长度取弦长的 1/3，保证接缝处 G1 连续（视觉上是顺滑的圆弧）。
 */
export function arcJoinHandles(fromNode, fromPrev, toNode, toNext) {
  const chord = Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y) || 1;
  const k = chord / 3;

  let dx = fromNode.x - fromPrev.x;
  let dy = fromNode.y - fromPrev.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-9) {
    dx = toNode.x - fromNode.x;
    dy = toNode.y - fromNode.y;
    len = Math.hypot(dx, dy) || 1;
  }
  const out = { x: fromNode.x + (dx / len) * k, y: fromNode.y + (dy / len) * k };

  let ex = toNext.x - toNode.x;
  let ey = toNext.y - toNode.y;
  let elen = Math.hypot(ex, ey);
  if (elen < 1e-9) {
    ex = toNode.x - fromNode.x;
    ey = toNode.y - fromNode.y;
    elen = Math.hypot(ex, ey) || 1;
  }
  const inn = { x: toNode.x - (ex / elen) * k, y: toNode.y - (ey / elen) * k };

  return { out, in: inn };
}

/**
 * 闭合轮廓。
 * @param {object} c 轮廓
 * @param {'line'|'arc'} mode 直线连接 / 圆弧连接
 *
 * - 首尾重合：合并为一个节点，接缝处按 mode 设置入控制柄（该节点同时拥有 in/out，可直接拖拽调整）
 * - 首尾分离：保留两个节点，用直线或圆弧段连接，两端控制柄同样可拖拽
 */
export function closeContourWith(c, mode = 'line') {
  const n = c.nodes;
  if (n.length < 3) return null;
  const first = n[0];
  const last = n[n.length - 1];
  const coincide = Math.hypot(first.x - last.x, first.y - last.y) < 1.0;

  if (coincide) {
    const nodes = n.slice(0, -1).map(cloneNode);
    if (mode === 'arc') {
      const prev = nodes[nodes.length - 1];
      const prev2 = nodes[nodes.length - 2] || prev;
      const next = nodes[1] || nodes[0];
      const { in: inh } = arcJoinHandles(prev, prev2, nodes[0], next);
      nodes[0].in = inh;
    } else {
      nodes[0].in = null;
    }
    return { closed: true, nodes };
  }

  const nodes = n.map(cloneNode);
  if (mode === 'arc') {
    const prev = nodes[nodes.length - 2] || nodes[nodes.length - 1];
    const next = nodes[1] || nodes[0];
    const { out, in: inh } = arcJoinHandles(nodes[nodes.length - 1], prev, nodes[0], next);
    nodes[nodes.length - 1].out = out;
    nodes[0].in = inh;
  } else {
    nodes[nodes.length - 1].out = null;
    nodes[0].in = null;
  }
  return { closed: true, nodes };
}

/** 兼容旧调用：直线闭合 */
export function closeContour(c) {
  return closeContourWith(c, 'line');
}

/**
 * 连接两个端点。
 * @param {object} A 轮廓
 * @param {'start'|'end'} whichA A 上被选中的端点
 * @param {object} B 轮廓
 * @param {'start'|'end'} whichB B 上被选中的端点
 * @param {boolean} same 是否为同一轮廓的两端（此时结果闭合）
 */
export function joinContours(A, whichA, B, whichB, same) {
  let a = whichA === 'end' ? cloneContour(A) : reverseContour(A);
  let b = whichB === 'start' ? cloneContour(B) : reverseContour(B);
  a.nodes[a.nodes.length - 1].out = null;
  b.nodes[0].in = null;

  const lastA = a.nodes[a.nodes.length - 1];
  const firstB = b.nodes[0];
  const coincide = Math.hypot(lastA.x - firstB.x, lastA.y - firstB.y) < 0.01;

  let nodes;
  if (coincide) {
    const merged = { x: lastA.x, y: lastA.y, in: lastA.in, out: firstB.out ? { ...firstB.out } : null };
    nodes = [...a.nodes.slice(0, -1), merged, ...b.nodes.slice(1)];
  } else {
    nodes = [...a.nodes, ...b.nodes];
  }
  return { closed: !!same, nodes };
}

/** 删除节点；节点不足时返回 null（表示整条轮廓应被移除） */
export function removeNodeAt(contour, ni) {
  const n = contour.nodes;
  if (ni < 0 || ni >= n.length) return contour;
  const min = contour.closed ? 3 : 2;
  if (n.length <= min) return null;
  const nodes = n.map(cloneNode);
  nodes.splice(ni, 1);
  // 端点被删后，残留控制柄会破坏形状，统一清掉
  if (!contour.closed) {
    if (ni === 0) nodes[0].in = null;
    if (ni === n.length - 1) nodes[nodes.length - 1].out = null;
  }
  return { closed: contour.closed, nodes };
}

/** 对轮廓的所有点（含控制柄）应用一个变换函数 */
export function transformContour(c, fn) {
  const tp = (p) => (p ? fn(p) : null);
  return {
    closed: !!c.closed,
    nodes: c.nodes.map((n) => {
      const p = fn(n);
      return { x: p.x, y: p.y, in: tp(n.in), out: tp(n.out) };
    }),
  };
}

/** 整体平移 */
export function translateContour(c, dx, dy) {
  for (const n of c.nodes) {
    n.x += dx;
    n.y += dy;
    if (n.in) { n.in.x += dx; n.in.y += dy; }
    if (n.out) { n.out.x += dx; n.out.y += dy; }
  }
}

/** 以 (ox, oy) 为中心缩放 */
export function scaleContour(c, ox, oy, sx, sy) {
  const f = (p) => ({ x: ox + (p.x - ox) * sx, y: oy + (p.y - oy) * sy });
  for (const n of c.nodes) {
    const p = f(n);
    n.x = p.x;
    n.y = p.y;
    if (n.in) n.in = f(n.in);
    if (n.out) n.out = f(n.out);
  }
}

/** 端点判定 */
export function nodeRole(contour, ni) {
  const last = contour.nodes.length - 1;
  if (contour.closed) return 'closed';
  if (ni === 0 && ni === last) return 'both';
  if (ni === 0) return 'start';
  if (ni === last) return 'end';
  return 'inner';
}

/** 统计 */
export function countStats(shapes) {
  let contours = 0;
  let nodes = 0;
  for (const s of shapes) {
    contours += s.contours.length;
    for (const c of s.contours) nodes += c.nodes.length;
  }
  return { shapes: shapes.length, contours, nodes };
}
