// 后端桥接层：Tauri invoke 封装 + 浏览器降级 mock（便于纯前端预览与自动化截图）。

const TAURI = globalThis.__TAURI__;
export const isTauri = !!(TAURI && TAURI.core && typeof TAURI.core.invoke === 'function');

export async function invoke(cmd, args) {
  if (isTauri) return TAURI.core.invoke(cmd, args);
  return mockInvoke(cmd, args);
}

// ---------------------------------------------------------------- mock

const MOCK_FONTS = [
  ['Mock Sans', 'MockSans-Regular', 400, 'Regular'],
  ['Mock Sans', 'MockSans-Bold', 700, 'Bold'],
  ['Mock Serif', 'MockSerif-Regular', 400, 'Regular'],
  ['Mock Mono', 'MockMono-Regular', 400, 'Regular'],
].map(([family, ps, weight, sub], i) => ({
  family,
  familyEn: family,
  subfamily: sub,
  postScriptName: ps,
  path: `C:/mock/${ps}.ttf`,
  index: i,
  weight,
  style: 'Normal',
  monospaced: family === 'Mock Mono',
}));

function mockGlyph(ch, x, baseline, size) {
  // 生成一个可辨识的方块字形，用于无后端时的界面预览
  const w = /[\u4e00-\u9fff]/.test(ch) ? size * 0.86 : size * 0.56;
  const h = size * 0.72;
  const top = baseline - h;
  const r = Math.min(w, h) * 0.18;
  const k = r * 0.5523;
  const nodes = [
    { x: x + r, y: top, in: null, out: null },
    { x: x + w - r, y: top, out: { x: x + w - r + k, y: top } },
    { x: x + w, y: top + r, in: { x: x + w, y: top + r - k } },
    { x: x + w, y: top + h - r, out: { x: x + w, y: top + h - r + k } },
    { x: x + w - r, y: top + h, in: { x: x + w - r + k, y: top + h } },
    { x: x + r, y: top + h, out: { x: x + r - k, y: top + h } },
    { x: x, y: top + h - r, in: { x: x, y: top + h - r + k } },
    { x: x, y: top + r, out: { x: x, y: top + r - k } },
  ];
  nodes[0].in = { x: x + r - k, y: top };
  return { closed: true, nodes };
}

function mockOutline(req) {
  const size = req.size;
  const sx = (size / 1000) * (req.widthScale || 1);
  const sy = size / 1000;
  const spacing = req.letterSpacing || 0;
  let pen = req.offsetX || 0;
  const shapes = [];
  let i = 0;
  for (const ch of req.text) {
    const adv = (/[\u4e00-\u9fff]/.test(ch) ? 1000 : 620) * sx + spacing;
    if (ch.trim()) {
      const contours = [mockGlyph(ch, pen, req.baselineY, size)];
      shapes.push({
        ch,
        line: req.lineIndex || 0,
        charIndex: (req.startIndex || 0) + i,
        contours,
        bbox: { x: pen, y: req.baselineY - size * 0.72, w: adv - spacing, h: size * 0.72 },
        advance: adv,
      });
    }
    pen += adv;
    i += 1;
  }
  return {
    shapes,
    bbox: shapes.reduce(
      (acc, s) => {
        if (!acc) return { ...s.bbox };
        const x = Math.min(acc.x, s.bbox.x);
        const y = Math.min(acc.y, s.bbox.y);
        const x2 = Math.max(acc.x + acc.w, s.bbox.x + s.bbox.w);
        const y2 = Math.max(acc.y + acc.h, s.bbox.y + s.bbox.h);
        return { x, y, w: x2 - x, h: y2 - y };
      },
      null
    ) || { x: 0, y: 0, w: 0, h: 0 },
    stats: { shapes: shapes.length, contours: shapes.length, nodes: shapes.length * 8 },
    missing: [],
    advance: pen,
  };
}

async function mockInvoke(cmd, args = {}) {
  await new Promise((r) => setTimeout(r, 30));
  switch (cmd) {
    case 'list_fonts':
      return MOCK_FONTS;
    case 'measure_text': {
      const req = args.req;
      const lines = String(req.text || '').split('\n');
      const widths = lines.map((l) => [...l].reduce((a, ch) => a + (/[\u4e00-\u9fff]/.test(ch) ? 1000 : 620) * (req.size / 1000) + (req.letterSpacing || 0), 0));
      return {
        lineWidths: widths,
        maxWidth: Math.max(0, ...widths),
        ascent: req.size * 0.88,
        descent: req.size * 0.22,
        unitsPerEm: 1000,
        missing: [],
      };
    }
    case 'outline_text':
      return mockOutline(args.req);
    case 'choose_folder':
      // 浏览器预览没有真实文件夹选择，返回 null 表示取消
      return null;
    case 'save_svg': {
      const blob = new Blob([args.svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = args.defaultName || 'glyph.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return `（浏览器预览模式）已下载 ${a.download}`;
    }
    case 'save_svgs_dialog': {
      for (const f of args.files || []) {
        const blob = new Blob([f.content], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${f.name || 'stroke'}.svg`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        await new Promise((r) => setTimeout(r, 120));
      }
      return { folder: '（浏览器预览模式）下载目录', count: (args.files || []).length, names: [] };
    }
    default:
      throw new Error(`未实现的命令：${cmd}`);
  }
}
