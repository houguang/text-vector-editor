// 应用状态 + 撤销/重做历史。所有模块共享同一个 state 对象。

const EXPORT_DIR_KEY = 'glyphcut.exportDir';

function readExportDir() {
  try {
    return globalThis.localStorage?.getItem(EXPORT_DIR_KEY) || null;
  } catch {
    return null;
  }
}

/** 记住/清除批量导出目录（localStorage 持久化，重启后仍生效） */
export function setExportDir(dir) {
  state.exportDir = dir || null;
  try {
    if (dir) globalThis.localStorage?.setItem(EXPORT_DIR_KEY, dir);
    else globalThis.localStorage?.removeItem(EXPORT_DIR_KEY);
  } catch {
    /* 浏览器隐私模式或存储不可用时忽略 */
  }
}

export function clearExportDir() {
  setExportDir(null);
}

export const state = {
  fonts: [],
  families: [],
  family: '',
  face: null,
  shapes: [],
  /** 笔画库：[{ id, name, example, contours: [Contour], frame }]，一个笔画可包含多条轮廓，与画布解耦（添加时快照） */
  strokes: [],
  /** 每个字符的字身框（em box）：cellKey → { x, y, w, h }，部首按整字位置保存时用它做参考框 */
  charCells: {},
  /** 每次转换/追加文字递增，用于生成不冲突的 cellKey */
  charSeq: 0,
  selection: { shapes: new Set(), nodes: new Set() },
  view: { scale: 1, tx: 0, ty: 0 },
  ui: { showNodes: true, showGrid: true, busy: false, tool: 'select', exWidth: 76, radicalMode: false },
  nextId: 1,
  nextStrokeId: 1,
  /** 上次批量导出选择的目录；有值时下次直接写入，不再弹文件夹选择框 */
  exportDir: readExportDir(),
  /** 当前作品：{ id, name, dirty } */
  project: { id: null, name: '', dirty: false },
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(reason = '') {
  for (const fn of listeners) fn(reason);
}

// 轻量提示通道，避免 canvas / edits 直接依赖 UI 模块
const toastSubs = new Set();
export function onToast(fn) {
  toastSubs.add(fn);
}
export function toast(text, kind = '') {
  for (const fn of toastSubs) fn(text, kind);
}

// ---------------------------------------------------------------- 历史

const HISTORY_LIMIT = 60;
const undoStack = [];
const redoStack = [];

function snapshot() {
  return JSON.stringify({
    shapes: state.shapes,
    strokes: state.strokes,
    shapesSel: [...state.selection.shapes],
    nodesSel: [...state.selection.nodes],
  });
}

/** 在修改文档之前调用，记录快照 */
export function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

/** 拖拽等连续操作：仅在开始拖动时记录一次 */
export function pushHistoryOnce(token) {
  if (state._dragToken === token) return;
  state._dragToken = token;
  pushHistory();
}

function restore(json) {
  const data = JSON.parse(json);
  state.shapes = data.shapes;
  state.strokes = data.strokes || [];
  state.selection.shapes = new Set(data.shapesSel);
  state.selection.nodes = new Set(data.nodesSel);
}

export function canUndo() {
  return undoStack.length > 0;
}
export function canRedo() {
  return redoStack.length > 0;
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  state._dragToken = null;
  emit('undo');
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  state._dragToken = null;
  emit('redo');
  return true;
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  state._dragToken = null;
}

export function historyDepth() {
  return { undo: undoStack.length, redo: redoStack.length };
}

// ---------------------------------------------------------------- 选择

export function clearSelection() {
  state.selection.shapes.clear();
  state.selection.nodes.clear();
}

export function selectedShapes() {
  return state.shapes.filter((s) => state.selection.shapes.has(s.id));
}

export function findShape(id) {
  return state.shapes.find((s) => s.id === id) || null;
}

/**
 * 生成新的对象 id。**必须跳过已存在的 id**：
 * 打开旧作品后 nextId 可能落后于文档里的实际 id，直接自增会产生重复 id，
 * 而选择集是按 id 存的（Set），重复 id 会导致「选一个却同时选中另一个」。
 */
export function nextShapeId() {
  const used = new Set(state.shapes.map((s) => s.id));
  let id = `s${state.nextId++}`;
  while (used.has(id)) id = `s${state.nextId++}`;
  return id;
}

/**
 * 修复历史数据里的重复 id：旧版本打开作品后可能产生撞号并已存盘，
 * 载入时重新分配重复项，保证 id 唯一。
 */
export function dedupeIds() {
  const seenShape = new Set();
  for (const s of state.shapes) {
    if (!s.id || seenShape.has(s.id)) s.id = nextShapeId();
    seenShape.add(s.id);
  }
  const seenStroke = new Set();
  for (const k of state.strokes) {
    if (!k.id || seenStroke.has(k.id)) k.id = nextStrokeIdSafe();
    seenStroke.add(k.id);
  }
}

function nextStrokeIdSafe() {
  const used = new Set(state.strokes.map((s) => s.id));
  let id = `k${state.nextStrokeId++}`;
  while (used.has(id)) id = `k${state.nextStrokeId++}`;
  return id;
}

/** 载入文档后把 id 计数器推到现有最大值之后，避免与已有对象撞号 */
export function syncNextIds() {
  let maxShape = 0;
  for (const s of state.shapes) {
    const m = /^s(\d+)$/.exec(s.id || '');
    if (m) maxShape = Math.max(maxShape, Number(m[1]));
  }
  let maxStroke = 0;
  for (const k of state.strokes) {
    const m = /^k(\d+)$/.exec(k.id || '');
    if (m) maxStroke = Math.max(maxStroke, Number(m[1]));
  }
  state.nextId = Math.max(state.nextId, maxShape + 1);
  state.nextStrokeId = Math.max(state.nextStrokeId, maxStroke + 1);
}
