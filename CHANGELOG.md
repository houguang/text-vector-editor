# 修复记录

## 2026-11-01 部首定位 + 作品库

- **按整字位置保存（部首）**：右栏新增「按整字位置保存」开关。关闭时按单笔自身包围盒居中放大（基本笔画）；打开时以字符**字身框（em box）**为参考框，框铺满 1000×1000，笔画保留在字中的位置与相对大小，导出后放进田字格即原位显示。字身框按 `cellKey` 存在 `state.charCells`，整字移动/缩放时同步变换，只动单笔时不动（`src/js/geometry.js`、`src/js/edits.js`、`src/js/export.js`）。
- **字身框计算修正**：`ascent + descent` 是错的——字体 descender 为负值会把框压短，笔画溢出方格下沿；中文字体的 typo/hhea 降部常是**行距值**（实测 −0.253em，字面框实际约 0.12em），直接用会把字顶到上方。改为 `side = max(字号, advance)`、`asc = clamp(em 升部, 0.88em, 0.95em)`，后端 `MeasureResponse` 新增 `emAscent`/`emDescent`（`src-tauri/src/outline.rs`）。
- **作品库**：工具栏新增「保存」（`Ctrl+S`）与「作品库」（`Ctrl+O`）。工程存到 `%APPDATA%\com.houguang.glyphcut\projects\`，正文与元信息分离，缩略图 160×160 PNG 存元信息里；弹层支持打开、改名另存、删除。打开时按 `family`/`subfamily` 还原字体（`src-tauri/src/store.rs`、`src/js/projects.js`）。
- **修复：打开作品后右侧笔画列表不刷新**：`applyDoc` 只发 `edit`，而列表只在 `strokes`/`undo`/`redo` 时重建；补发 `strokes` 并让 `openProject` 调 `refreshPanels(true)`。
- **修复：打开作品后 id 撞号**：`applyDoc` 未把 `nextId` 推到已有 id 之后，新建对象复用 `s1`，而选择集是 `Set<id>`——表现为「选一个却同时选中另一个」「加进去的不是选中的那个」「预览空白」。新增 `syncNextIds()` / `dedupeIds()`，并让 `nextShapeId()` 跳过已占用 id。
- **修复：部首预览空白**：笔画存的是快照字身框，字被挪动后框与字形错位。转换时记录 `cell.ink`，添加时按「当前墨迹 − 记录墨迹」重新锚定，并在缩略图/导出处用「框 ∪ 墨迹」兜底。
- **框选不再叠加 Shift**：中文输入法切换中英文常按 Shift，`Shift + 框选` 追加选择会让用户误以为选中逻辑出错；框选改为始终覆盖，加选改用 `Shift + 点选`。
- 前端测试 **66**（新增字身框、作品库、id 唯一性、错位兜底等用例）；Rust 测试 **12**（新增 `pen_x` 递推、字身框覆盖墨迹、作品库 id 校验）。

## 2026-10-27 追加需求

- **导出居中/放大**：`buildSVG` 与 `buildContourSVG` 改为以本次导出内容自身包围盒为参考框，等比放大到 900×900 并居中；批量导出每个笔画独立居中放大，不再共用一个包含整份文档的 frame（`src/js/export.js`）。
- **双击画布追加文字**：双击空白画布弹出单行输入框，`Enter` 确认后在双击位置追加文字——**旧路径的几何、顺序和选择集保持不变**，只向文档追加新字形；新文字以双击点为视觉中心，并进入撤销栈（`Ctrl+Z` 可撤销本次添加），`Esc` 取消；双击已有线段仍保持“插入节点”（`src/js/canvas.js`、`src/js/ui.js`、`src/index.html`、`src/styles.css`）。
- **默认字体**：优先「方正新楷体简体」，未安装时按 `方正新楷体 → 楷体 / KaiTi / 楷体_GB2312 / 华文楷体 / STKaiti` 顺序回退，最后回退到任意中文字体（`src/js/ui.js`）。
- **笔画库多选合并**：`addStrokesFromSelection()` 把本次选中的所有闭合轮廓合并成一个 `Stroke`（`contours: [Contour]`），不再一个路径生成一个笔画；例字自动去重。缩略图、节点统计、`↻` 更新与批量导出都支持多轮廓（`src/js/edits.js`、`src/js/ui.js`、`src/js/export.js`）。
- **批量导出目录记忆**：首次选择目录后写入 `localStorage`，之后通过 `save_svgs_to` 直接写入，不再弹选择框；右栏新增「目录…」按钮可更改。记住的目录失效时自动清除并回退到文件选择（`src/js/export.js`、`src/js/ui.js`、`src-tauri/src/save.rs`）。
- 前端测试 **49**；Rust 测试增至 **9**，新增“多选合并为一个笔画、多轮廓导出为一个 SVG、批量写盘同名冲突、导出目录持久化”等用例。
- 用当前构建重新生成 `docs/reference/app-verified.png`（CDP 截图，默认字体「方正新楷体简体」）；旧图继续留在 `legacy/`。

## 2026-10-27

### 正确性

- 导出 SVG 的 `<title>` 对 `& < > " '` 做 XML 转义，笔画名含特殊字符不再生成非法 SVG（`src/js/export.js`）。
- 输入框/文本框中按 `Ctrl+Z` / `Ctrl+Y` 不再触发画布撤销，保留文本框自身撤销；`Ctrl+Enter` 仍可转换（`src/js/ui.js`）。
- `cutAt` / `joinSelectedEndpoints` / `closeSelectedContours` 先校验、在副本上计算，失败时不再向撤销栈塞入空快照（`src/js/edits.js`）。
- `insertNodeAtHit` 在副本上插入，失败不再返回“成功”并选中不存在的节点。
- 切断开放轮廓后生成两条独立路径，保持“一条路径 = 一个轮廓”的模型；移除只被测试调用的 `cutSelectedNodes`。
- 插入节点增加索引/参数校验，越界或 `NaN` 安全返回 `false`（`src/js/geometry.js`）。
- `fitView` 支持纯水平/垂直的退化包围盒。

### 性能

- 每个 shape 的 `Path2D` 按 id 缓存，平移/缩放/悬停不再逐帧重建 path；编辑/撤销/重做后失效，拖拽期间绕过缓存。
- 命中测试先用 shape 包围盒预筛，避免每次鼠标移动全文档逐段采样。
- 笔画列表只在笔画库变化/撤销/重做时重建；选择和普通几何编辑不再重绘所有缩略图。

### 安全与工程化

- 删除 `save_svg_to` 命令（可写任意路径的测试后门）。
- 不再注册 `tauri-plugin-fs`、移除所有 fs 权限；写盘只走 Rust 命令。
- 批量导出避开 Windows 保留文件名、限制 80 字符、遇到已有文件自动加后缀，不静默覆盖。
- 修复 `familyEn` 直接取 `families[0]` 的假设，优先选 ASCII 族名。
- 保存/选文件夹对话框改为 `spawn_blocking` 等待，不阻塞 async worker。
- 新增 `.gitignore`、`npm test` 脚本；移除未使用的 `@tauri-apps/api`、`setZoom`、`viewSize`、`state.lastFont`。
- 新增 `↻` 按钮：用当前选中闭合路径更新已有笔画（复用原本未接线的 `updateStrokeGeometry`）。

### 文档与测试

- 重写 README：修正测试数量、按钮名、已移除的“填充模式/参数面板/对齐”等描述，删除不存在的 `tools/make_icons.py` 引用。
- 旧版 UI 截图归档到 `docs/reference/legacy/`，不再作为当前界面说明。
- 前端测试从 36 增至 **41**（追加需求后 **49**）；Rust 测试从 5 增至 **9**，覆盖 XML 转义、撤销栈污染、笔画更新、批量写盘/同名冲突、文件名保留名/长度、英文族名选择。
