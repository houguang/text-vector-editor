// 入口：装配画布与 UI。

import { initCanvas } from './canvas.js';
import { initUI } from './ui.js';
import * as G from './geometry.js';
import * as E from './edits.js';
import * as C from './canvas.js';
import * as S from './state.js';
import * as X from './export.js';
import * as P from './projects.js';

async function boot() {
  const canvas = document.getElementById('canvas');
  if (!canvas) throw new Error('缺少 #canvas 节点');
  initCanvas(canvas);
  await initUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// 自动化测试 / 调试钩子：便于通过 CDP 驱动真实 UI 做端到端校验
globalThis.__gc = { G, E, C, S, X, P };
