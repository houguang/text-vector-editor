// 作品库：把画布（路径 + 字身框 + 笔画库 + 字体 + 视图）序列化成工程文档，
// 通过后端存到应用数据目录，可列表 / 打开 / 删除。
// 本模块只处理数据，不碰 DOM，便于在 Node 里直接测试。

import { state, emit, clearHistory, clearSelection, syncNextIds, dedupeIds } from './state.js';
import { invoke } from './api.js';
import * as C from './canvas.js';

export const DOC_VERSION = 1;

/** 生成不与文件系统冲突的工程 id（只含字母数字与短横线） */
export function newProjectId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 当前文档 → JSON 字符串 */
export function serializeDoc({ name, text } = {}) {
  return JSON.stringify({
    version: DOC_VERSION,
    name: name || '未命名',
    text: text == null ? '' : text,
    font: state.face
      ? {
          family: state.face.family,
          subfamily: state.face.subfamily,
          path: state.face.path,
          index: state.face.index,
        }
      : null,
    shapes: state.shapes,
    charCells: state.charCells || {},
    charSeq: state.charSeq || 0,
    strokes: state.strokes || [],
    view: { ...state.view },
    savedAt: Date.now(),
  });
}

/**
 * JSON 字符串 → 当前文档。返回需要 UI 同步的附加信息（文本、字体、名称）。
 * 不负责刷新界面，调用方拿到返回值后自己更新。
 */
export function applyDoc(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || !Array.isArray(data.shapes)) {
    throw new Error('工程文件格式不正确');
  }
  state.shapes = data.shapes;
  state.strokes = Array.isArray(data.strokes) ? data.strokes : [];
  state.charCells = data.charCells || {};
  state.charSeq = Number.isFinite(data.charSeq) ? data.charSeq : 0;
  if (data.view && Number.isFinite(data.view.scale) && data.view.scale > 0) {
    state.view = { ...data.view };
  }
  // 关键：先修复历史数据里的重复 id，再把计数器推到已有 id 之后
  syncNextIds();
  dedupeIds();
  syncNextIds();
  clearSelection();
  clearHistory();
  // 'edit' 让画布重绘、'strokes' 让右侧笔画列表重建（列表只在 strokes/undo/redo 时刷新）
  emit('edit');
  emit('strokes');
  return {
    name: data.name || '未命名',
    text: typeof data.text === 'string' ? data.text : '',
    font: data.font || null,
    savedAt: data.savedAt || 0,
  };
}

/** 保存当前文档（id 为空则新建），返回后端写入的元信息 */
export async function saveProject({ id, name, text }) {
  const pid = id || newProjectId();
  const data = serializeDoc({ name, text });
  const thumb = C.renderThumbnail(160);
  return invoke('save_project', {
    id: pid,
    name: name || '未命名',
    data,
    shapes: state.shapes.length,
    strokes: state.strokes.length,
    thumb,
  });
}

export const listProjects = () => invoke('list_projects');
export const loadProject = (id) => invoke('load_project', { id });
export const removeProject = (id) => invoke('delete_project', { id });
