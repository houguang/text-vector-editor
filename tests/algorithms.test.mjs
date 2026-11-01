// 前端核心算法与编辑链路测试（纯 Node 运行，不依赖浏览器）。
// 运行： node tests/algorithms.test.mjs

import assert from 'node:assert/strict';
import * as G from '../src/js/geometry.js';
import * as S from '../src/js/state.js';
import * as E from '../src/js/edits.js';
import { buildSVG, buildContourSVG, buildStrokeSVG } from '../src/js/export.js';
import { pickDefaultFamily, textAnchorFrame } from '../src/js/ui.js';
import * as P from '../src/js/projects.js';

let pass = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

// ---------------------------------------------------------------- 测试数据

function square(x, y, size, curved = false) {
  const k = curved ? size * 0.15 : 0;
  const nodes = [
    { x, y, in: null, out: null },
    { x: x + size, y, in: null, out: null },
    { x: x + size, y: y + size, in: null, out: null },
    { x, y: y + size, in: null, out: null },
  ];
  if (curved) {
    nodes[0].out = { x: x + k, y };
    nodes[1].in = { x: x + size - k, y };
    nodes[1].out = { x: x + size, y: y + k };
    nodes[2].in = { x: x + size, y: y + size - k };
    nodes[2].out = { x: x + size - k, y: y + size };
    nodes[3].in = { x: x + k, y: y + size };
    nodes[3].out = { x, y: y + size - k };
    nodes[0].in = { x, y: y + k };
  }
  return { closed: true, nodes };
}

function line(n) {
  return {
    closed: false,
    nodes: Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, in: null, out: null })),
  };
}

function resetDoc(shapes) {
  S.state.shapes = shapes;
  S.state.strokes = [];
  S.state.charCells = {};
  S.state.charSeq = 0;
  S.state.ui.radicalMode = false;
  S.clearSelection();
  S.clearHistory();
  S.state.nextId = 100;
  S.state.nextStrokeId = 1;
}

function sampleContour(c, steps = 24) {
  const pts = [];
  for (const s of G.contourSegments(c)) {
    const sp = G.segmentSamples(s.a, s.b, steps);
    pts.push(...(pts.length ? sp.slice(1) : sp));
  }
  return pts;
}

/** 解析导出 SVG 中第一条 path 的坐标范围（偶数下标 x，奇数下标 y） */
function svgPathBox(svg) {
  const d = svg.match(/ d="([^"]+)"/)[1];
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

// ---------------------------------------------------------------- 几何

test('pathData 生成 M/C/L/Z 合法命令', () => {
  const d = G.contourToPathData(square(0, 0, 100, true));
  assert.match(d, /^M /);
  assert.match(d, / C /);
  assert.match(d, / Z$/);
  assert.equal((d.match(/M/g) || []).length, 1);
});

test('闭合轮廓 bbox 正确', () => {
  const box = G.contourBBox(square(10, 20, 100));
  assert.equal(Math.round(box.x), 10);
  assert.equal(Math.round(box.y), 20);
  assert.equal(Math.round(box.w), 100);
  assert.equal(Math.round(box.h), 100);
});

test('多轮廓 shape bbox 取并集', () => {
  const shape = { id: 'a', contours: [square(0, 0, 10), square(100, 100, 10)] };
  const box = G.shapeBBox(shape);
  assert.equal(Math.round(box.w), 110);
  assert.equal(Math.round(box.h), 110);
});

// ---------------------------------------------------------------- 切断

test('闭合轮廓切断 → 一条开放轮廓，首尾同点', () => {
  const c = square(0, 0, 100, true);
  const parts = G.splitContourAt(c, 2);
  assert.equal(parts.length, 1);
  const [p] = parts;
  assert.equal(p.closed, false);
  assert.equal(p.nodes.length, c.nodes.length + 1);
  const f = p.nodes[0];
  const l = p.nodes[p.nodes.length - 1];
  assert.ok(Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9, '首尾应重合');
  assert.equal(f.in, null, '起点不应有入控制柄');
  assert.equal(l.out, null, '终点不应有出控制柄');
  // 切断后几何不变
  const before = sampleContour(c, 8).length;
  const after = sampleContour(p, 8).length;
  assert.ok(after >= before, '切断后采样点不应减少');
});

test('开放轮廓中间切断 → 两条开放轮廓', () => {
  const c = line(5);
  const parts = G.splitContourAt(c, 2);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].nodes.length, 3);
  assert.equal(parts[1].nodes.length, 3);
  assert.equal(parts[0].nodes[2].out, null);
  assert.equal(parts[1].nodes[0].in, null);
});

test('端点处切断返回 null（无需切断）', () => {
  assert.equal(G.splitContourAt(line(4), 0), null);
  assert.equal(G.splitContourAt(line(4), 3), null);
});

// ---------------------------------------------------------------- 连接

test('两条开放轮廓连接成一条', () => {
  const a = line(3);
  const b = { closed: false, nodes: [{ x: 100, y: 0, in: null, out: null }, { x: 110, y: 0, in: null, out: null }] };
  const joined = G.joinContours(a, 'end', b, 'start', false);
  assert.equal(joined.closed, false);
  assert.equal(joined.nodes.length, 5);
  assert.equal(joined.nodes[2].out, null);
  assert.equal(joined.nodes[3].in, null);
});

test('反向连接会自动调整端点朝向', () => {
  const a = line(3);
  const b = { closed: false, nodes: [{ x: 100, y: 0, in: null, out: null }, { x: 110, y: 0, in: null, out: null }] };
  const joined = G.joinContours(a, 'start', b, 'start', false);
  // a 反转后末端为原首节点 (0,0)
  assert.equal(joined.nodes[2].x, 0);
  assert.equal(joined.nodes[3].x, 100);
});

test('同一轮廓两端连接 → 闭合', () => {
  const c = line(4);
  const closed = G.closeContour(c);
  assert.equal(closed.closed, true);
  assert.equal(closed.nodes.length, 4);
});

test('首尾重合的开放轮廓闭合时合并节点', () => {
  const c = line(3);
  c.nodes.push({ x: 0, y: 0, in: null, out: null });
  const closed = G.closeContour(c);
  assert.equal(closed.nodes.length, 3);
  assert.equal(closed.closed, true);
});

test('圆弧闭合：合并闭合点并生成切向连续的入柄', () => {
  const c = square(0, 0, 100, true);
  const [open] = G.splitContourAt(c, 0);
  const closed = G.closeContourWith(open, 'arc');
  assert.equal(closed.closed, true);
  assert.equal(closed.nodes.length, 4);
  const n0 = closed.nodes[0];
  assert.ok(n0.in, '闭合点应有入控制柄，可手动拖拽');
  assert.ok(n0.out, '闭合点应保留出控制柄');
  // 入柄方向应与「闭合点→下一节点」共线（G1 连续）
  const n1 = closed.nodes[1];
  const v1 = { x: n0.x - n0.in.x, y: n0.y - n0.in.y };
  const v2 = { x: n1.x - n0.x, y: n1.y - n0.y };
  const cross = v1.x * v2.y - v1.y * v2.x;
  const norm = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  assert.ok(Math.abs(cross) / norm < 1e-6, '接缝处切线应共线');
});

test('直线闭合：闭合点无入控制柄', () => {
  const c = square(0, 0, 100, true);
  const [open] = G.splitContourAt(c, 0);
  const closed = G.closeContourWith(open, 'line');
  assert.equal(closed.nodes.length, 4);
  assert.equal(closed.nodes[0].in, null);
});

test('首尾分离时圆弧/直线闭合的控制柄差异', () => {
  const c = {
    closed: false,
    nodes: [
      { x: 0, y: 0, in: null, out: null },
      { x: 50, y: 0, in: null, out: null },
      { x: 50, y: 50, in: null, out: null },
      { x: 0, y: 60, in: null, out: null },
    ],
  };
  const arc = G.closeContourWith(c, 'arc');
  assert.equal(arc.nodes.length, 4);
  assert.ok(arc.nodes[3].out, '圆弧闭合应给末节点出柄');
  assert.ok(arc.nodes[0].in, '圆弧闭合应给首节点入柄');

  const lin = G.closeContourWith(c, 'line');
  assert.equal(lin.nodes[3].out, null);
  assert.equal(lin.nodes[0].in, null);
});

test('闭合后闭合点手柄可继续编辑', () => {
  resetDoc([{ id: 'A', ch: 'A', contours: [square(0, 0, 100, true)] }]);
  E.cutAt('A', { ni: 0 });
  assert.equal(S.state.shapes[0].contours[0].closed, false);
  E.selectShape(S.state.shapes[0].id, false);
  const res = E.closeSelectedContours('arc');
  assert.equal(res.ok, true, res.msg);
  const c = S.state.shapes[0].contours[0];
  assert.equal(c.closed, true);
  assert.ok(c.nodes[0].in, '闭合点应可继续调整手柄');
  // 拖动闭合点手柄后几何发生变化
  const before = JSON.stringify(c.nodes[0].in);
  c.nodes[0].in = { x: c.nodes[0].in.x - 10, y: c.nodes[0].in.y };
  assert.notEqual(JSON.stringify(c.nodes[0].in), before);
});

// ---------------------------------------------------------------- 插入 / 删除

test('曲线中点插入节点保持几何不变', () => {
  const c = square(0, 0, 100, true);
  const a = c.nodes[0];
  const b = c.nodes[1];
  const expected = G.cubicAt(a, a.out, b.in, b, 0.5);
  const boxBefore = G.contourBBox(c, 40);
  G.insertNodeAt(c, 0, 0.5);
  assert.equal(c.nodes.length, 5);
  const inserted = c.nodes[1];
  assert.ok(Math.hypot(inserted.x - expected.x, inserted.y - expected.y) < 1e-9, '新节点应精确落在曲线上');
  const boxAfter = G.contourBBox(c, 40);
  assert.ok(Math.abs(boxBefore.x - boxAfter.x) < 1e-6 && Math.abs(boxBefore.w - boxAfter.w) < 1e-6, '包围盒不应改变');
  // 原控制柄被正确拆分
  assert.ok(inserted.in && inserted.out, '新节点应带双侧控制柄');
});

test('直线段插入节点落在中点', () => {
  const c = line(2);
  G.insertNodeAt(c, 0, 0.5);
  assert.equal(c.nodes.length, 3);
  assert.equal(c.nodes[1].x, 5);
});

test('删除节点', () => {
  const c = square(0, 0, 100);
  const next = G.removeNodeAt(c, 1);
  assert.equal(next.nodes.length, 3);
  assert.equal(G.removeNodeAt({ closed: true, nodes: [0, 1, 2].map((i) => ({ x: i, y: 0 })) }, 0), null);
});

test('插入节点参数越界时安全返回 false', () => {
  const c = line(2);
  assert.equal(G.insertNodeAt(c, 1, 0.5), false, '开放轮廓的最后一段不是闭合段');
  assert.equal(G.insertNodeAt(c, 5, 0.5), false);
  assert.equal(G.insertNodeAt(c, -1, 0.5), false);
  assert.equal(G.insertNodeAt(c, 0, NaN), false);
  assert.equal(c.nodes.length, 2, '失败时不应修改轮廓');
});

// ---------------------------------------------------------------- 字体默认值

test('默认字体：优先方正新楷体简体，缺失回退楷体', () => {
  const fam = (name, familyEn = name) => ({ name, faces: [{ familyEn }] });
  const list = [fam('微软雅黑'), fam('楷体'), fam('方正新楷体简体', 'FZXKT--GB1-0')];
  assert.equal(pickDefaultFamily(list).name, '方正新楷体简体');
  assert.equal(pickDefaultFamily([fam('微软雅黑'), fam('楷体')]).name, '楷体');
  assert.equal(pickDefaultFamily([fam('KaiTi')]).name, 'KaiTi');
  assert.equal(pickDefaultFamily([fam('Microsoft YaHei')]).name, 'Microsoft YaHei');
  assert.equal(pickDefaultFamily([]), null);
});

test('画布追加文字：以双击点作为文字框中心', () => {
  const frame = textAnchorFrame({ lineWidths: [100], ascent: 80, descent: -20 }, { x: 500, y: 400 });
  assert.equal(frame.startX, 450, '水平中心应在 500');
  assert.equal(frame.baselineY, 430, '垂直中心应在 400（baseline 下移 30）');
  // 退化 measure 也要有可用值
  const fallback = textAnchorFrame({}, { x: 0, y: 0 });
  assert.equal(fallback.startX, 0);
  assert.ok(fallback.baselineY > 0);
});

test('批量导出目录：写入/清除 localStorage', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  S.setExportDir('D:\\glyphcut-export');
  assert.equal(S.state.exportDir, 'D:\\glyphcut-export');
  assert.equal(store.get('glyphcut.exportDir'), 'D:\\glyphcut-export');
  S.clearExportDir();
  assert.equal(S.state.exportDir, null);
  assert.equal(store.has('glyphcut.exportDir'), false);
  delete globalThis.localStorage;
});

// ---------------------------------------------------------------- 文档级操作 + 撤销

function seedDoc() {
  resetDoc([
    {
      id: 'A',
      ch: 'A',
      contours: [square(0, 0, 100, true)],
      bbox: { x: 0, y: 0, w: 100, h: 100 },
    },
    {
      id: 'B',
      ch: 'B',
      contours: [line(4)],
      bbox: { x: 0, y: 0, w: 30, h: 0 },
    },
  ]);
}

test('闭合轮廓在节点处切断 → 变为开放轮廓', () => {
  seedDoc();
  const res = E.cutAt('A', { ni: 2 });
  assert.equal(res.ok, true, res.msg);
  assert.equal(S.state.shapes[0].contours.length, 1);
  const c = S.state.shapes[0].contours[0];
  assert.equal(c.closed, false);
  assert.equal(c.nodes.length, 5);
});

test('开放轮廓切断成两条独立路径后可再连接', () => {
  seedDoc();
  const res = E.cutAt('B', { ni: 1 });
  assert.equal(res.ok, true, res.msg);
  // 关键：切断后必须是两条独立路径，而不是一个 shape 里的两个 contour
  assert.equal(S.state.shapes.length, 3);
  const left = S.state.shapes[1];
  const right = S.state.shapes[2];
  assert.equal(left.contours.length, 1);
  assert.equal(right.contours.length, 1);
  E.selectNode(left.id, 0, left.contours[0].nodes.length - 1, false);
  E.selectNode(right.id, 0, 0, true);
  const joined = E.joinSelectedEndpoints();
  assert.equal(joined.ok, true, joined.msg);
  assert.equal(S.state.shapes.length, 2);
  assert.equal(S.state.shapes[1].contours[0].nodes.length, 4);
});

test('连接失败不污染撤销栈', () => {
  resetDoc([{ id: 'E', ch: 'E', contours: [line(2)] }]);
  E.selectNode('E', 0, 0, false);
  E.selectNode('E', 0, 1, true);
  const before = S.historyDepth().undo;
  const res = E.joinSelectedEndpoints();
  assert.equal(res.ok, false);
  assert.equal(S.historyDepth().undo, before);
});

test('闭合失败不污染撤销栈', () => {
  resetDoc([{ id: 'A', ch: 'A', contours: [square(0, 0, 100)] }]);
  E.selectShape('A', false);
  const before = S.historyDepth().undo;
  const res = E.closeSelectedContours('line');
  assert.equal(res.ok, false);
  assert.equal(S.historyDepth().undo, before);
});

test('在端点处切断不污染撤销栈', () => {
  resetDoc([{ id: 'D', ch: 'D', contours: [line(3)] }]);
  const before = S.historyDepth().undo;
  const res = E.cutAt('D', { ni: 0 });
  assert.equal(res.ok, false);
  assert.equal(S.historyDepth().undo, before);
});

test('撤销/重做连续 10 次编辑仍正确', () => {
  seedDoc();
  const original = JSON.stringify(S.state.shapes);
  for (let i = 0; i < 10; i++) {
    E.selectNode('A', 0, 0, false);
    E.insertNodeAfterSelected();
  }
  assert.equal(S.state.shapes[0].contours[0].nodes.length, 14, '10 次插入后节点数应为 14');
  for (let i = 0; i < 10; i++) assert.equal(S.undo(), true, `第 ${i + 1} 次撤销失败`);
  assert.equal(JSON.stringify(S.state.shapes), original, '撤销后应回到初始状态');
  assert.equal(S.canUndo(), false);
  for (let i = 0; i < 10; i++) assert.equal(S.redo(), true, `第 ${i + 1} 次重做失败`);
  assert.equal(S.state.shapes[0].contours[0].nodes.length, 14, '重做后应恢复 14 个节点');
});

test('删除节点后轮廓不合法时移除整条轮廓', () => {
  resetDoc([{ id: 'C', ch: 'C', contours: [line(2)], bbox: { x: 0, y: 0, w: 10, h: 0 } }]);
  E.selectNode('C', 0, 0, false);
  const res = E.deleteSelection();
  assert.equal(res.ok, true);
  assert.equal(S.state.shapes.length, 0);
});

test('整体缩放', () => {
  resetDoc([{ id: 'D', ch: 'D', contours: [square(0, 0, 100)] }]);
  const snap = E.snapshotShapes(S.state.shapes);
  E.applyScaleToShapes(snap, 0, 0, 2, 0.5);
  const c = S.state.shapes[0].contours[0];
  assert.equal(c.nodes[1].x, 200);
  assert.equal(c.nodes[2].y, 50);
});

test('整体平移保留控制柄相对位置', () => {
  resetDoc([{ id: 'E', ch: 'E', contours: [square(0, 0, 100, true)] }]);
  const snap = E.snapshotShapes(S.state.shapes);
  const before = JSON.parse(JSON.stringify(S.state.shapes[0].contours[0].nodes));
  E.applyTranslateToShapes(snap, 30, -10);
  const after = S.state.shapes[0].contours[0].nodes;
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(after[i].x - (before[i].x + 30)) < 1e-9);
    assert.ok(Math.abs(after[i].y - (before[i].y - 10)) < 1e-9);
    if (before[i].out) {
      assert.ok(Math.abs(after[i].out.x - (before[i].out.x + 30)) < 1e-9);
    }
  }
});

test('空文档导出校验', () => {
  resetDoc([]);
  assert.equal(G.shapesBBox([]), null);
});

// ---------------------------------------------------------------- 点切断工具

test('点切断：闭合路径在节点处断开为开口路径', () => {
  resetDoc([{ id: 'A', ch: 'A', contours: [square(0, 0, 100, true)] }]);
  const res = E.cutAt('A', { ni: 1 });
  assert.equal(res.ok, true, res.msg);
  assert.equal(S.state.shapes.length, 1);
  assert.equal(S.state.shapes[0].contours[0].closed, false);
  assert.equal(S.state.shapes[0].contours[0].nodes.length, 5);
});

test('点切断：开放路径中间切断为两条独立路径', () => {
  resetDoc([{ id: 'B', ch: 'B', contours: [line(5)] }]);
  const res = E.cutAt('B', { ni: 2 });
  assert.equal(res.ok, true, res.msg);
  assert.equal(S.state.shapes.length, 2);
  assert.equal(S.state.shapes[0].contours[0].nodes.length, 3);
  assert.equal(S.state.shapes[1].contours[0].nodes.length, 3);
});

test('点切断：线段任意位置先插节点再切断', () => {
  resetDoc([{ id: 'C', ch: 'C', contours: [line(2)] }]);
  const res = E.cutAt('C', { si: 0, t: 0.5 });
  assert.equal(res.ok, true, res.msg);
  assert.equal(S.state.shapes.length, 2);
  assert.equal(S.state.shapes[0].contours[0].nodes.length, 2);
});

test('点切断：端点处无效', () => {
  resetDoc([{ id: 'D', ch: 'D', contours: [line(3)] }]);
  const res = E.cutAt('D', { ni: 0 });
  assert.equal(res.ok, false);
  assert.equal(S.state.shapes.length, 1);
});

test('点切断可撤销', () => {
  resetDoc([{ id: 'E', ch: 'E', contours: [square(0, 0, 100)] }]);
  E.cutAt('E', { ni: 2 });
  assert.equal(S.state.shapes[0].contours[0].closed, false);
  S.undo();
  assert.equal(S.state.shapes.length, 1);
  assert.equal(S.state.shapes[0].contours[0].closed, true);
});

// ---------------------------------------------------------------- 笔画库

test('笔画库：只能添加闭合路径', () => {
  resetDoc([
    { id: 'A', ch: '小', contours: [square(0, 0, 100)] },
    { id: 'B', ch: 'B', contours: [line(3)] },
  ]);
  E.selectShape('B', false);
  assert.equal(E.addStrokesFromSelection().ok, false);

  E.selectShape('A', false);
  const res = E.addStrokesFromSelection();
  assert.equal(res.ok, true, res.msg);
  assert.equal(S.state.strokes.length, 1);
  assert.equal(S.state.strokes[0].example, '小');
  assert.equal(S.state.strokes[0].contours.length, 1);
  assert.equal(S.state.strokes[0].contours[0].closed, true);
});

test('笔画库：选中多个路径时合并为一个笔画', () => {
  resetDoc([
    { id: 'A', ch: '们', contours: [square(0, 0, 100)] },
    { id: 'B', ch: '们', contours: [square(200, 0, 100)] },
    { id: 'C', ch: '开', contours: [line(3)] },
  ]);
  E.selectShapes(['A', 'B', 'C'], false);
  const res = E.addStrokesFromSelection();
  assert.equal(res.ok, true, res.msg);
  assert.equal(S.state.strokes.length, 1, '多选只生成一个笔画');
  assert.equal(S.state.strokes[0].contours.length, 2, '两个闭合路径进入同一笔画');
  assert.equal(S.state.strokes[0].example, '们', '例字去重');
  assert.match(res.msg, /1 个笔画/);
  assert.match(res.msg, /跳过 1 条开放路径/);
});

test('笔画库：添加时快照，画布后续编辑不影响已存笔画', () => {
  resetDoc([{ id: 'A', ch: '小', contours: [square(0, 0, 100)] }]);
  E.selectShape('A', false);
  E.addStrokesFromSelection();
  const before = JSON.stringify(S.state.strokes[0].contours);
  const snap = E.snapshotShapes(S.state.shapes);
  E.applyTranslateToShapes(snap, 50, 50);
  assert.equal(JSON.stringify(S.state.strokes[0].contours), before);
});

test('笔画库：添加与删除可撤销', () => {
  resetDoc([{ id: 'A', ch: '小', contours: [square(0, 0, 100)] }]);
  E.selectShape('A', false);
  E.addStrokesFromSelection();
  assert.equal(S.state.strokes.length, 1);
  S.undo();
  assert.equal(S.state.strokes.length, 0);
  S.redo();
  assert.equal(S.state.strokes.length, 1);
  E.removeStroke(S.state.strokes[0].id);
  assert.equal(S.state.strokes.length, 0);
});

test('笔画库：可用选中路径更新已有笔画', () => {
  resetDoc([{ id: 'A', ch: '小', contours: [square(0, 0, 100)] }]);
  E.selectShape('A', false);
  E.addStrokesFromSelection();
  const stroke = S.state.strokes[0];
  assert.equal(stroke.name, '笔画 1');

  const snap = E.snapshotShapes(S.state.shapes);
  E.applyTranslateToShapes(snap, 50, 50);
  E.selectShape('A', false);
  const res = E.updateStrokeGeometry(stroke.id);
  assert.equal(res.ok, true, res.msg);
  assert.equal(S.state.strokes[0].contours[0].nodes[0].x, 50);
  assert.equal(S.state.strokes[0].contours[0].nodes[0].y, 50);
  assert.equal(S.state.strokes[0].name, '笔画 1', '更新几何不应改变名称');
});

// ---------------------------------------------------------------- 导出

test('导出 SVG 固定 1000×1000 视框且只含描边', () => {
  resetDoc([{ id: 'A', ch: 'A', contours: [square(0, 0, 100)] }]);
  const svg = buildSVG(S.state.shapes);
  assert.ok(svg.includes('viewBox="0 0 1000 1000"'), 'viewBox 应为 0 0 1000 1000');
  assert.ok(svg.includes('width="1000" height="1000"'), '画布尺寸应为 1000×1000');
  assert.ok(svg.includes('fill="none"'), '应为描边模式');
  assert.ok(!svg.includes('fill="#000000"'), '不应出现填充');

  const d = svg.match(/ d="([^"]+)"/)[1];
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(nums.every((v) => v >= -1 && v <= 1001), '坐标应烘焙进 0..1000');
  const xs = nums.filter((_, i) => i % 2 === 0);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 800, '内容应被放大到接近满框');
});

test('单笔画导出：标题、描边与 1000 视框', () => {
  resetDoc([{ id: 'A', ch: 'A', contours: [square(0, 0, 100)] }]);
  const svg = buildContourSVG(square(0, 0, 100), '竖钩');
  assert.ok(svg.includes('<title>竖钩</title>'));
  assert.ok(svg.includes('viewBox="0 0 1000 1000"'));
  assert.ok(svg.includes('fill="none"'));
  assert.equal(buildContourSVG({ closed: false, nodes: [] }), null);
});

test('多轮廓笔画导出为一个 SVG，包含全部子路径', () => {
  const a = square(0, 0, 100);
  const b = square(200, 0, 100);
  const svg = buildStrokeSVG([a, b], '双轮廓');
  assert.ok(svg);
  assert.ok(svg.includes('<title>双轮廓</title>'));
  const d = svg.match(/ d="([^"]+)"/)[1];
  assert.equal((d.match(/M /g) || []).length, 2, '两条轮廓应有两个 M 子路径');
  const box = svgPathBox(svg);
  assert.ok(box.w > 890, `整体应放大到约 900 宽：${box.w}`);
});

test('笔画名里的 XML 特殊字符会被转义', () => {
  const svg = buildContourSVG(square(0, 0, 100), 'A&B <test>');
  assert.ok(svg.includes('<title>A&amp;B &lt;test&gt;</title>'), 'title 必须是合法 XML');
  assert.ok(!svg.includes('<title>A&B'));
  // 属性引号也要处理，避免未来把名称放进属性时出问题
  const quoted = buildContourSVG(square(0, 0, 100), 'a"b\'c');
  assert.ok(quoted.includes('a&quot;b&apos;c'));
});

test('单笔画导出：小笔画会被放大并居中', () => {
  const tiny = square(10000, 10000, 10);
  const box = svgPathBox(buildContourSVG(tiny, 'tiny'));
  assert.ok(box.w > 890 && box.h > 890, `小笔画应铺满可用区域：${box.w}×${box.h}`);
  assert.ok(box.x >= 49 && box.x <= 51, `左边界应约为 50：${box.x}`);
  assert.ok(box.y >= 49 && box.y <= 51, `上边界应约为 50：${box.y}`);
});

test('退化笔画（纯水平线）导出时也居中，不再返回 null', () => {
  const flat = line(2);
  const svg = buildContourSVG(flat, 'flat');
  assert.ok(svg, '纯水平线也应有导出结果');
  const box = svgPathBox(svg);
  assert.ok(box.w > 890, `长度应放大：${box.w}`);
  assert.ok(Math.abs(box.y - 500) < 1, `垂直方向应居中：${box.y}`);
});

test('单笔画导出：不同大小的笔画各自归一化，不再受画布其他内容影响', () => {
  const big = square(0, 0, 100);
  const small = square(5000, 0, 10);
  // 即使画布上还有其他远处内容，导出的单个笔画也以自身为参考框
  resetDoc([
    { id: 'A', ch: 'A', contours: [big] },
    { id: 'B', ch: 'B', contours: [square(20000, 20000, 5)] },
  ]);
  const wb = svgPathBox(buildContourSVG(big, 'big')).w;
  const ws = svgPathBox(buildContourSVG(small, 'small')).w;
  assert.ok(Math.abs(wb - ws) < 1, `都应约 900 宽：${wb} vs ${ws}`);
});

test('选中导出：以选中内容为参考框居中，而不是整份文档', () => {
  resetDoc([
    { id: 'A', ch: 'A', contours: [square(0, 0, 100)] },
    { id: 'B', ch: 'B', contours: [square(5000, 0, 100)] },
  ]);
  const svg = buildSVG([S.state.shapes[0]], 'selection');
  const box = svgPathBox(svg);
  assert.ok(box.w > 890, `选中内容应放大：${box.w}`);
  assert.ok(box.x >= 49 && box.x <= 51, `应居中偏左 50：${box.x}`);
  assert.ok(box.y >= 49 && box.y <= 51, `应居中偏上 50：${box.y}`);
});

// ---------------------------------------------------------------- 字身框（部首按整字位置保存）

test('部首模式：记录字身框并按框映射到满格', () => {
  resetDoc([{ id: 'A', ch: '他', cellKey: 'c1_0', contours: [square(10, 10, 40)] }]);
  S.state.charCells = { c1_0: { x: 0, y: 0, w: 100, h: 100 } };
  E.selectShape('A', false);
  const res = E.addStrokesFromSelection({ useCell: true });
  assert.equal(res.ok, true, res.msg);

  const st = S.state.strokes[0];
  assert.deepEqual(st.frame, { x: 0, y: 0, w: 100, h: 100 });
  assert.ok(st.name.startsWith('部首'));

  const svg = buildStrokeSVG(st.contours, '部首', st.frame);
  assert.ok(svg.includes('viewBox="0 0 1000 1000"'));
  const d = svg.match(/ d="([^"]+)"/)[1];
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  // 方块在字身框内位于 (10,10)-(50,50)，框宽 100；含 2% 安全余量后 s=9.6、偏移 20
  assert.ok(Math.abs(Math.min(...xs) - 116) < 1, `minX=${Math.min(...xs)}`);
  assert.ok(Math.abs(Math.max(...xs) - 500) < 1, `maxX=${Math.max(...xs)}`);
});

test('笔画模式：不记录字身框，按自身包围盒铺满', () => {
  resetDoc([{ id: 'A', ch: '他', cellKey: 'c1_0', contours: [square(10, 10, 40)] }]);
  S.state.charCells = { c1_0: { x: 0, y: 0, w: 100, h: 100 } };
  E.selectShape('A', false);
  const res = E.addStrokesFromSelection({ useCell: false });
  assert.equal(res.ok, true, res.msg);
  assert.equal(S.state.strokes[0].frame, null);

  const svg = buildStrokeSVG(S.state.strokes[0].contours, '笔画', null);
  const d = svg.match(/ d="([^"]+)"/)[1];
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  // 铺满可用区域（1000 - 50*2 = 900）
  assert.ok(Math.max(...xs) - Math.min(...xs) > 850, '单笔应放大到接近满格');
});

test('缺少字身框时给出明确提示', () => {
  resetDoc([{ id: 'A', ch: '他', cellKey: null, contours: [square(0, 0, 10)] }]);
  E.selectShape('A', false);
  const res = E.addStrokesFromSelection({ useCell: true });
  assert.equal(res.ok, false);
  assert.ok(res.msg.includes('字身框'));
});

test('整字移动时字身框同步，单笔移动时不动', () => {
  resetDoc([
    { id: 'A', ch: '他', cellKey: 'k', contours: [square(0, 0, 10)] },
    { id: 'B', ch: '他', cellKey: 'k', contours: [square(20, 0, 10)] },
  ]);
  S.state.charCells = { k: { x: 0, y: 0, w: 100, h: 100 } };

  E.applyTranslateToShapes(E.snapshotShapes([S.state.shapes[0]]), 30, 40);
  assert.equal(S.state.charCells.k.x, 0, '只动一部分时字身框不应移动');
  assert.equal(S.state.charCells.k.y, 0);

  E.applyTranslateToShapes(E.snapshotShapes(S.state.shapes), 5, 7);
  assert.equal(S.state.charCells.k.x, 5, '整字移动时字身框应同步');
  assert.equal(S.state.charCells.k.y, 7);
});

test('整字缩放时字身框同步缩放', () => {
  resetDoc([{ id: 'A', ch: '他', cellKey: 'k', contours: [square(0, 0, 10)] }]);
  S.state.charCells = { k: { x: 10, y: 20, w: 100, h: 100 } };
  E.applyScaleToShapes(E.snapshotShapes(S.state.shapes), 0, 0, 2, 2);
  assert.deepEqual(S.state.charCells.k, { x: 20, y: 40, w: 200, h: 200 });
});

test('字身框：正方形、基线在框内约 88% 处', () => {
  // 实测字体：size=120, OS/2 typo 升部 0.812em、降部 −0.253em（行距值，不是字面框）
  const cell = G.charCell(0, 120, 120, 97.44, 126.97);
  assert.equal(cell.w, cell.h, '字身框应为正方形');
  assert.equal(cell.w, 120, '边长应等于字号');
  assert.equal(cell.x, 0, 'advance 等于字号时不应有水平偏移');
  assert.ok(Math.abs(cell.y - 21.37) < 0.01, `顶边=${cell.y}`);
  // 基线（126.97）应落在框内约 88% 处
  const ratio = (126.97 - cell.y) / cell.h;
  assert.ok(ratio > 0.85 && ratio < 0.92, `基线位置=${(ratio * 100).toFixed(1)}%`);
});

test('字身框：降部按 0.12em 处理，不被字体行距值带偏', () => {
  // 若误用 typo 降部 0.253em，框会变成 1.065em 高，字被顶到上方
  const cell = G.charCell(0, 120, 120, 97.44, 126.97);
  const bottomGap = cell.y + cell.h - 126.97;
  assert.ok(Math.abs(bottomGap - 14.4) < 0.5, `框底距基线应为 0.12em，实际 ${bottomGap}`);
});

test('字身框：拉丁字符按 advance 取宽并居中', () => {
  const cell = G.charCell(100, 60, 120, 96, 96);
  assert.equal(cell.w, 120);
  assert.equal(cell.x, 70, '窄字符应在字宽内居中');
});

test('字身框：升部异常时被限制在 0.88~0.95em', () => {
  const low = G.charCell(0, 120, 120, 10, 126.97); // 升部过小 → 抬到 0.88em
  assert.ok(Math.abs(126.97 - low.y - 105.6) < 0.01, `升部=${126.97 - low.y}`);
  const high = G.charCell(0, 120, 120, 200, 126.97); // 升部过大 → 压到 0.95em
  assert.ok(Math.abs(126.97 - high.y - 114) < 0.01, `升部=${126.97 - high.y}`);
});

// ---------------------------------------------------------------- 作品库

test('作品序列化 → 反序列化完整还原', () => {
  resetDoc([{ id: 'A', ch: '他', cellKey: 'c1_0', contours: [square(0, 0, 10)] }]);
  S.state.strokes = [
    { id: 'k1', name: '亻', example: '他', contours: [square(0, 0, 5)], frame: { x: 0, y: 0, w: 100, h: 100 } },
  ];
  S.state.charCells = { c1_0: { x: 0, y: 0, w: 100, h: 100 } };
  S.state.charSeq = 3;
  S.state.view = { scale: 2.5, tx: 11, ty: 22 };
  S.state.face = { family: 'X', subfamily: 'Bold', path: 'C:/x.ttf', index: 0 };

  const raw = P.serializeDoc({ name: '他', text: '他\n们' });

  // 清空后重新载入
  S.state.shapes = [];
  S.state.strokes = [];
  S.state.charCells = {};
  S.state.view = { scale: 1, tx: 0, ty: 0 };

  const info = P.applyDoc(raw);
  assert.equal(info.name, '他');
  assert.equal(info.text, '他\n们');
  assert.equal(info.font.family, 'X');
  assert.equal(S.state.shapes.length, 1);
  assert.equal(S.state.strokes.length, 1);
  assert.deepEqual(S.state.strokes[0].frame, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(S.state.charCells.c1_0, { x: 0, y: 0, w: 100, h: 100 });
  assert.equal(S.state.charSeq, 3);
  assert.equal(S.state.view.scale, 2.5);
});

test('打开损坏的工程会报错而不是崩溃', () => {
  assert.throws(() => P.applyDoc('{"nope":1}'), /格式不正确/);
  assert.throws(() => P.applyDoc('not json'), SyntaxError);
});

test('工程 id 只含安全字符', () => {
  const id = P.newProjectId();
  assert.match(id, /^[a-z0-9-]+$/);
  assert.notEqual(id, P.newProjectId());
});

// ---------------------------------------------------------------- id 唯一性（打开作品后的回归）

test('打开作品后 id 计数器会推到已有 id 之后', () => {
  resetDoc([
    { id: 's1', ch: 'A', contours: [square(0, 0, 10)] },
    { id: 's7', ch: 'A', contours: [square(20, 0, 10)] },
  ]);
  S.state.nextId = 1; // 模拟新会话：计数器落后于文档
  S.state.strokes = [{ id: 'k5', name: 'x', contours: [square(0, 0, 5)] }];
  S.state.nextStrokeId = 1;

  S.syncNextIds();
  assert.equal(S.nextShapeId(), 's8');
  assert.equal(S.nextShapeId(), 's9');
  assert.equal(E.nextStrokeId(), 'k6');
});

test('nextShapeId 会跳过已被占用的 id', () => {
  resetDoc([{ id: 's2', ch: 'A', contours: [square(0, 0, 10)] }]);
  S.state.nextId = 2; // 计数器正好落在已用 id 上
  assert.equal(S.nextShapeId(), 's3');
});

test('重复 id 会让选择集同时命中两个对象（问题复现）', () => {
  resetDoc([
    { id: 's1', ch: 'A', contours: [square(0, 0, 10)] },
    { id: 's1', ch: 'B', contours: [square(500, 0, 10)] },
  ]);
  E.selectShape('s1', false);
  assert.equal(S.selectedShapes().length, 2, '同 id 的两个对象会一起被选中');
});

// ---------------------------------------------------------------- 字身框与墨迹错位

test('旧数据：框没跟着字走时，添加部首会按当前墨迹重新锚定', () => {
  resetDoc([{ id: 'A', ch: '他', cellKey: 'k', contours: [square(300, 0, 10)] }]);
  // 模拟旧工程：框还停在转换时的位置（当时墨迹在 0,0）
  S.state.charCells = { k: { x: -10, y: -10, w: 100, h: 100, ink: { x: 0, y: 0, w: 10, h: 10 } } };
  E.selectShape('A', false);
  const res = E.addStrokesFromSelection({ useCell: true });
  assert.equal(res.ok, true, res.msg);
  const f = S.state.strokes[0].frame;
  assert.ok(Math.abs(f.x - 290) < 1e-6, `框应平移 300，实际 x=${f.x}`);
  assert.ok(f.x + f.w >= 310, '框应覆盖当前墨迹');
});

test('框与墨迹错位时导出仍把笔画放进画布内', () => {
  const c = square(900, 900, 20); // 远在框外
  const svg = buildStrokeSVG([c], 'x', { x: 0, y: 0, w: 100, h: 100 });
  assert.ok(svg, '不应返回 null');
  const d = svg.match(/ d="([^"]+)"/)[1];
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(nums.every((v) => v >= -1 && v <= 1001), '坐标应落在 0..1000 内');
});

// ---------------------------------------------------------------- 汇总

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
