# ChatExplorer — 项目进度与约定

> Edge (MV3) 扩展，用文件管理器式的 UI 替代 claude.ai 的 1296 条会话平铺列表。
> 索引完全本地。设计规范在 `D:\Downloads\DESIGN.md`（已跟到 2026-09-24）。
> **对话用中文。**
>
> **工作目录（2026-09-24 起）：`D:\Desktop\ChatExplorer Another\`**。旧目录
> `D:\Desktop\ChatExplorer\` 已弃用：另一个 session 在那里留下了一个编译不过的
> 半成品 AI 整理功能。本目录是叠放做完时的干净状态，AI 整理功能在这里从头重做。
> Edge 里加载的解压扩展要改指向本目录的 `dist`。
>
> 最近一轮的详细交接见根目录的 [`HANDOFF.md`](HANDOFF.md)。

---

## 0. 不可违反的硬约束

1. **claude.ai 只读，永不回写。** 本地重命名、标记、文件夹、隐藏状态全部只存在本地 IndexedDB。
2. **测试配额**：需要真实 claude.ai 测试时最高用 Sonnet，Opus 一次会话最多两次；测试消息越短越好（「回复ok即可」这种）；优先开新对话而不是接长对话；能用网络/DOM 检查解决的就不要真的跑补全。
3. **绝对不要 `ConvertFrom-Json` Edge 的 `Preferences` 文件** —— 解析会失败并把约 580 KB 个人资料倒进输出（之前泄漏到 `bz1dkmrg1.txt`，已提示用户删除）。
4. 文件系统语义：每个会话有且只有**一个**真实位置；快捷方式是别名且带可见标记；`Ctrl+C` = 复制为快捷方式，`Ctrl+X` = 移动。
5. UI chrome 中**不出现 emoji**（用户数据里的 emoji 原样透传）；所有数值取自 CSS 变量；所有 UI 文案走 i18n；所有对话框/toast 自绘，**绝不用浏览器原生 confirm/alert**；删除必须二次确认；删除 = 隐藏状态（软删除）。
6. 设计规范允许灵活调整，**但每一处偏离都必须告知用户**（用户原话：「后续只需告知」）。

## 0.1 用户已确认的决策（正在实现）

- UI 可以直接读 IndexedDB，但**写入只有一个入口**，并通过 BroadcastChannel 广播；data-port 接口保留。
- 搜索 = 全量扫描 + 大小写与全角/半角归一化。
- 详情视图**默认 compact**（单行、仅标题）；comfortable 多显示一行摘要。
- 撤销：一次手势 = 一步，无合并窗口。
- 偏差 1–9 + 「同步时保留隐藏状态」+「隐藏按祖先解析」：全部批准，需写回 DESIGN.md。
- 缩略图只有两档（<90px 画线条，≥90px 用 10px 字号可读）；模型标签按图标 12% 缩放、永不省略号、<48px 隐藏；标记竖向堆叠、16px 上限；文字避开折角。
- 图标视图：选中项名称展开时图标保持可见，名称向下生长；drop 状态只出现在文件夹上。
- 详情视图：行间距 2px，独立圆角 hover/选中块，内缩 4px。
- 框选：**所有视图**（含详情视图）都支持，Ctrl+拖拽为追加，靠近边缘自动滚动。
- 深色主题完整重调（#1A1A18 / #211F1D / #2C2A27 / #2F2D29 / #3D3830，纸面 #2E2C28 / #4A4640 / #3A3833，文件夹 #A8864F / #7E6440，标签对比度 ≥4.5:1）。
- 滚动条全部自绘：8px → hover 10px，无轨道，全圆角，Firefox 用 scrollbar-color。

---

## 1. 文件地图（初建于 2026-09-17，表内签名持续更新）

### `src/app/`

| 文件 | 内容 |
| --- | --- |
| `dataport.ts` | **唯一写入入口**。`onDataChanged(fn)` 订阅；`notify()` 通知本地监听者 + `BroadcastChannel("chatexplorer-data")` 扇出；`writes()` 包装器。导出 `port`（30 个动作，全部带 notify）：<br>文件夹 `createFolder / renameFolder / moveFolder / setFolderHidden`<br>回收站 `purgeRefs / restoreRefs / setChatsHidden`<br>会话 `setChatsFlagged / moveChats / renameChat / setNotes`<br>快捷方式 `createShortcuts / moveShortcuts / deleteShortcuts`<br>**叠放 `createStack / dissolveStack / renameStack / addToStack / removeFromStack`**<br>**AI 整理 `applyAgentOps / jumpBefore / saveAiConfig`**<br>其它 `setPositions / undo / redo / jumpTo / saveView / resetView / saveSettings / sync` |
| `model.ts` | 纯视图模型层（无 IndexedDB、无 React），666 行。`VirtualId` / `Location` / `locationKey` / `sameLocation` / `Item` / `StackInfo` / `itemKey` / `subtreeIds` / `normalizeForSearch` / `makeListContext` / `listItems` / **`autoStackId` / `foldStacks` / `stackableKeys` / `stacksOf` / `isAutoStack`** / `naturalAsc` / `sortItems` / `groupItems` / `refsToChatUuids` / `countsFor`。<br>**管线顺序是 `listItems → sortItems → foldStacks → groupItems`**，不能改（见 §7）。 |
| `app.css` | Shell 布局：`.app` / `.app-toolbar` / `.app-main`（nav 220px / content / preview 300px）/ `.view-scroll`（共享滚动容器，marquee 的坐标系，position:relative）/ `.icon-grid` / 单元格与行的 `content-visibility: auto` + `contain-intrinsic-size` / `.rename-input` / 预览面板 / 遮罩、菜单、toast、picker、设置面板。 |
| `useAppData.ts` | 并行加载 `snapshot()` + `loadViews()` + `loadSettings()` + `historyState()` + `getMeta(lastSyncAt)`；订阅 `onDataChanged`；挂载时 `requestAuth`；`runSync()` 管理 syncing / syncError 并在同步后复查登录态。 |
| `overlays.tsx` | `ConfirmDialog`（遮罩点击/Esc 关闭，确认按钮自动聚焦）、`ToastHost`（5 秒自动过期）、`ContextMenu`（视口翻转，外部 mousedown / Esc / blur 关闭）、`Picker`（输入 + ↑↓/Enter/Esc，上限 100 条）、`SettingsPanel`。 |
| `views.tsx` | `IconView` / `DetailsView` / `ItemHandlers` / `ViewProps` / `cellClass()` / `RenameInput`。详情列宽 `COL_WIDTH = {updatedAt:150, createdAt:150, model:110, location:190, starred:56}`，name 列 flex:1；表头点击排序走 `onSortBy`。 |
| **`useMarquee.ts`** | **框选，全程不碰 React**。`useMarquee(scrollRef, { getSelection, onCommit })` → `{ start(e), rectRef }`。rAF 循环：矩形用**内容坐标**（与滚动无关），由 `rectRef` 指向的常驻 div 直接写 `style` 移动；命中项用 `classList.toggle("is-selected")` **命令式上色**（比对 DOM 而非记忆集合，App 若中途重渲染下一帧会自愈）；只有 pointerup 时 `onCommit(keys)` 把结论交给 React **一次**。边缘自动滚动 `EDGE = 28px` / `MAX_SPEED = 18`；盒子缓存 `REMEASURE_MS = 120` 节流；**4px 死区**（未越过死区不 commit，那是一次点击）；起始时按住 Ctrl/Meta = 与起始选择集求并。 |
| `chrome.tsx` | `NavTree`（虚拟节点 unfiled→inbox / recent→clock / flagged→bookmark / starred→star / missing→unlink / hidden→eyeOff + 计数，文件夹树、拼音排序、拖放目标）、`Toolbar`（前进/后退/上一层、面包屑、搜索框、视图/排序/新建/同步/预览/更多）、`StatusBar`、`PreviewPane`（标题、官方标题、元信息、笔记草稿 blur 保存、打开/移动按钮）、**`StackPreview`**（选中一摞时替代 PreviewPane：时间段、成员数、位置、模型分布、成员列表、展开/取消叠放）。 |
| `App.tsx` | **完整 shell，2145 行**。导航历史、选择、剪贴板、编辑、拖放、键盘、右键菜单、Picker、设置、toast、叠放、AI 面板的开关与网格高亮全在这里；视图只收 props。 |
| **`agent-panel.tsx`** | AI 整理面板（653 行）。占预览窗格的位置；状态全在 `AgentRunner` 上，`onChange` 按 rAF 节流重渲染，**不会**重渲染 App。`UserTurn` / `AssistantTurn` / `ToolRow`。 |
| **`agent-settings.tsx`** | 设置面板里的「AI 整理」一节 + 共用的 `apiErrorText()`（每种失败一句能照做的话）。 |
| **`model.test.ts`** | 单元测试，**29 个用例**（详见 §2）。 |

### `src/agent/` —— AI 整理（2026-09-24 新建，全部纯逻辑 + 一个 I/O 文件）

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `AiConfig` / `AgentScope` / `Turn` / `Block`（`TextBlock` \| `ToolBlock`）/ `Session`。**工具调用和它的结果存在同一个 block 里**，发请求时才拆成两条消息。 |
| `scope.ts` | `resolveAccess(scope, snap)` → `Access`（`canReadChat / canWriteChat / canReadFolder / canMoveInto / canCreateIn / canEditFolder`）。**权限边界在这里用代码强制**。三种模式：all / folders / chats。 |
| `ids.ts` | `IdRegistry`：UUID ↔ `c12` / `f3` 短编号，懒分配、随会话持久化、永不复用。 |
| `tools.ts` | 4 个读工具（`get_overview` / `list_chats` / `search_chats` / `read_chats`）+ 1 个写工具 `apply_changes`（一批 = 一步撤销）+ `remember_preference`（提议记住一条偏好，永远要用户确认，不是撤销步骤）。`planChanges()` 是把不可信的模型输出变成 ops 的地方。 |
| `context.ts` | `buildMessages(turns)`：拆 tool block、给没跑完的调用补结果、**旧读取结果按总量折叠**（`READ_BUDGET = 120_000` 字，超出才从最旧的折叠）。 |
| `rewind.ts` | `planRewind` / `rewindStatus` / `stepState`，纯函数。 |
| `providers.ts` | 两种接口格式的请求构造 + 流式事件映射 + `Assembler`；`endpointUrl()` 解析用户随手粘的地址。 |
| `sse.ts` | 增量 SSE 解析器（容忍 CRLF、无 event 行、任意位置断包）。 |
| `client.ts` | **唯一碰网络的文件**。`streamChat` / `testConnection` / `ApiError`；400 时按报错文本定向重试一次（`max_completion_tokens` / `stream_options`）。 |
| `config.ts` | `loadAiConfig` / `saveAiConfig`（单独的 meta 键 `aiConfig`）/ `ensureHostPermission`（按域名申请 optional 权限）。 |
| `sessions.ts` | 会话与回合的 IndexedDB 读写。**不走 data port**（见偏差 #49）。 |
| `prompt.ts` | 系统提示词；刻意不含会变的数字，便于缓存。 |
| `runner.ts` | `AgentRunner`：`send` / `resume` / `stop` / `decide` / `rewind`。 |

### 其它目录里与本项目约定强相关的文件

| 文件 | 内容 |
| --- | --- |
| `src/core/schema.ts` | **`DB_VERSION = 4`**（v4 = `agentSessions` + `agentTurns` 两个存储；`META_KEY.aiConfig`）；`Folder` / `Chat` / `Shortcut` / **`Stack`** / `FolderView` / `Settings`；`STACK_MIN_MEMBERS = 2`；`AutoStackKey = "off" \| "day"`。 |
| `src/core/db.ts` | 升级链 `migrateToV2` / `migrateToV3`（`stacks`）/ **`migrateToV4`**（`agentSessions` keyPath `id`；`agentTurns` 复合键 `[sessionId, idx]`）。 |
| `src/core/ops.ts` | 撤销原语与逆操作。**9** 个原语：`folder.put/del`、`chat.put/patch/del`、`shortcut.put/del`、`stack.put/del`。**`MAX_LOG = 1000`**；`commit` 返回 seq；新增 `jumpBefore(seq)` / `logIndex()`。 |
| `src/core/store.ts` | 25 个变更函数，全部写事务日志（新增 `applyAgentOps`）；`uniqueName` 已导出。 |
| `src/core/settings.ts` | 新增 `agentWidth` 与 `PANE_LIMITS.agent`（320–720，默认 400）。 |
| `src/ui/markdown.tsx` | 新增 `summaryHead(md, maxChars)`：简介第一段的纯文本。 |
| `src/ui/format.ts` | `displayName` / `firstSentence` / **`dayKey`（本地日，不是 `iso.slice(0,10)`）** / **`rangeLabel`**。 |

### 2026-09-17 那一轮对既有文件的改动（存档）

- `src/app/main.tsx` —— **已改为挂载新 shell**：`createRoot(...).render(<StrictMode><App /></StrictMode>)` + `import "./app.css"`。旧的 debug shell 与 `styles.css` 引用已移除（`src/app/styles.css` 现在是孤儿文件，可删）。
- `src/core/schema.ts` —— `defaultView()` 的 density 由 `"comfortable"` 改为 `"compact"`。
- `src/core/settings.ts` —— `DEFAULT_SETTINGS.defaultDensity` 改为 `"compact"`。
- `src/ui/i18n.ts` —— 新增 `close` 键（en: `"Close"` / zh-CN: `"关闭"`），供设置面板关闭按钮使用（此前是硬编码 "OK"，违反 i18n 规则）。
- `src/app/app.css` —— 补齐 `.details-row` 的 `is-drop` / `is-dragging` / `is-focus` / `is-cut` 状态样式（此前只有 `.grid-cell` 有，详情视图共用同一套选择机制却没有对应视觉）。

### 长期有效的编译约束（存档：下列改动早已被编译器确认）

tsconfig 开了 `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals` +
`noUnusedParameters`。**写新代码时这四条一直都在**，尤其 `noUncheckedIndexedAccess`
会让任何 `arr[i]` 变成 `T | undefined`。2026-09-17 据此排查出的几处：

- `App.tsx`：`formatWhen()` 去掉未使用的 `t` 参数；删除 `void ICON_SIZE;` 占位 hack 与 `ICON_SIZE` 导入。
- `App.tsx`：`hist.stack[hist.index] ?? HOME`；`navigate()` 内 `current &&` 判空；`selectedChatItems[0]?.chat`。
- `overlays.tsx`：`Picker` 的 Enter 分支改为先取 `const hit = shown[clamped]` 再判空。
- `useMarquee.ts`：`state.current` 的类型收窄在 addEventListener 之后会失效，改为先赋给局部 `st` 再用 `st.raf = requestAnimationFrame(frame)`。

---

## 2. `src/app/model.test.ts` 覆盖范围

纯对象输入输出，仿照 `src/core/store.test.ts` 的 fixture 风格（`folder()` / `chat()` / `shortcut()` / `snap()` / `ctxOf()` 工厂，`translator("en")`）。用例：

1. `normalizeForSearch` 全角字母数字折叠、U+3000 表意空格 → 半角空格、中文不变。
2. `locationKey` / `sameLocation` 三种 Location 互不混淆。
3. `subtreeIds` 包含自身且深度递归。
4. 文件夹视图列出子文件夹 + 会话 + **存活的**快捷方式（目标被隐藏或已消失的快捷方式跳过）；隐藏文件夹不出现在父级。
5. 隐藏文件夹内的会话在所有虚拟视图与计数中不可见；「已删除」视图只列**顶层**隐藏项，不列其子树（避免误导性的局部恢复）。
6. `recent` 遵守 `recentCount` 且按 updatedAt 倒序。
7. 搜索：全角折叠、扫描 notes、scope 子树限制、匹配文件夹名、空查询返回空。
8. 排序：文件夹永远在前；日期排序下文件夹块仍按名称排；升降序翻转会话顺序但**不翻转**文件夹块。
9. 分组：`none` 产生单个无标签组；`month` 按 updatedAt 分桶且文件夹单独成组。
10. `refsToChatUuids` 解析快捷方式目标并去重，忽略文件夹 ref 与失效 ref；
    **传入 `stacksOf(items)` 时能把一摞展开成全部成员**，不传则安全地返回空。
11. `countsFor` 只统计可见会话；`hidden` 计数 = 隐藏会话 + 隐藏文件夹。

叠放（2026-09-22 新增 10 例）：

12. 存储的一摞折成一格，默认名是成员的时间段；手输的名字盖过派生名。
13. 只剩一个成员还在的一摞**散开渲染**，不做「一摞一个」。
14. 展开后成员紧跟在折叠按钮之后，`inStack` / `stackIndex` 正确。
15. 按日自动叠放**盖过**存储的手工叠放；详情视图永不折叠。
16. **文件夹永远不会被吞进一摞**（三处过滤用同一个 `foldable` 谓词）。
17. 一个 stack ref 解析为摞里的每一条对话。
18. `stackableKeys`：选中一摞 + 一条散的 → 合并成三条，不嵌套；文件夹被剔除、重复项折叠。

### 其它测试文件

`src/core/store.test.ts`(23) / `src/claude/sync.test.ts`(13) / `src/ui/markdown.test.ts`(8) /
`src/core/model.test.ts`(4) / `src/ui/format.test.ts`(4) / `src/ui/tokens.test.ts`(1)；`markdown.test.ts` 现为 9（+ 编号列表跨段保号）。

AI 整理（2026-09-24 新增 43 例）：

- `src/agent/agent.test.ts`(27)：搜索（`|`/`OR`、英文整词、标题优先）、只看标题一页 500 条、按总量折叠、提示词里偏好的有无与位置、短编号、三种范围、读工具输出格式、`planChanges` 的全部动作与拒绝路径、
  「权限按原始记录判定」、消息拆分与折叠、回退计划与状态。
- `src/agent/providers.test.ts`(9)：地址解析、两种流式格式（乱切数据块、CRLF、并行工具调用、
  被截断的参数、流中错误、忽略 stream 的中转站）、两种请求体。
- `src/agent/runner.test.ts`(10)：记住偏好（总要确认、去重、拒绝不存）、**用脚本化的假 API + fake-indexeddb 端到端**跑循环：一批 = 一步、
  审批闸门、删除必审、停止、HTTP 错误、重试、轮数上限、回退。
- `store.test.ts` +3：`jumpBefore`、`logIndex`、`commit` 返回 seq。

合计 **10 个文件 / 133 个测试**。

---

## 3. 当前状态（2026-09-24 更新）

**版本 0.2.0**（manifest 与 package.json 同步；设置 → 关于 里显示，读自 manifest）。
manifest 描述已改：旧描述「Folders and names are stored locally only」在有了 AI 整理之后
不再完全准确——使用它时，对话标题与简介会发往用户自己配置的接口。

`npm run typecheck` / `npm test -- --run`（**10 个文件 / 133 个测试**）/ `npm run build`
三件套全部通过。DESIGN.md 回写已跟到 2026-09-24 这一轮（新增 §11.2 AI 整理；§4.3.1 叠放加两条修订）。

注意事项：

- Bash 工具的 cwd 是 `D:\Desktop`，**不是项目目录**（2026-09-22 复核仍然如此：
  每个新会话都会重置回去，虽然同一会话内 `cd` 会保持）。跑脚本一律先
  `cd "/d/Desktop/ChatExplorer Another"`（**路径里有空格，必须加引号**），**不要**写
  `cd /d D:\...`（Bash 是 git-bash，会报 `cd: too many arguments`）。
- **源码里绝不能出现字面 NUL 字节**。分隔符一律写 `\u0000` 转义——写成真的 U+0000
  会让 Grep 把整个文件判成二进制、Edit 工具匹配失败，而 Read 却一切正常，
  非常难查。2026-09-22 在 `App.tsx` 里踩过一次。
- Edit 工具拒绝编辑本会话尚未 Read 过的文件（报 "File has not been read yet"），
  先 Read 目标区域再改。
- **不要对本仓库跑 prettier**：没有配置文件，默认风格（80 列、尾逗号）和项目风格
  （100 列、无尾逗号）不一致，跑一次就会把整个文件改花。
- preview 服务器在 `.claude/launch.json` 里叫 `showcase`，但注册表（`D:\Desktop\.claude\launch.json`）
  里的名字是 **`chatexplorer-showcase`**，`preview_start` 要用后者。2026-09-24 已改指向本目录，
  并改成 `node …\vite\bin\vite.js`——路径里的空格会让 `vite.cmd` 在 cmd 下断开。
- **App 页面现在可以在开发服务器里打开**（`http://localhost:5174/app.html`）：`onSyncProgress`
  加了非扩展环境的判断，以前在扩展外直接崩。库是空的，需要用 JS 往 IndexedDB 塞测试数据；
  AI 面板可以接一个本地的假 API（脚本化 SSE，带 CORS）来完整跑一遍而不花钱——本轮就是这样验的。

已通过 Grep 逐一核对过的契约（都对得上，不必重查）：`store.ts` 全部变更函数签名、`ops.ts` 的 undo/redo/historyState/historyLog/jumpTo、`views.ts` 的 loadViews/resolveView/saveView/resetView、`settings.ts` 的 loadSettings/saveSettings、`db.ts` 的 getMeta、`api.ts` 的 `AuthStatus`、`messaging.ts` 的 requestSync/requestAuth、`Icon.tsx` 的全部 IconName、`ChatIcon.tsx` 的 ChatIcon/FolderIcon/ModelTag props、`schema.ts` 的 FolderView/SortKey/GroupKey/ColumnKey、`i18n.ts` 的全部键（代码中用到的键 100% 存在）、`components.css` 的类名清单。

---

## 4. 剩余任务

代码层面 2026-09-24 的 **AI 整理**与叠放两处修改已全部落地，
`npm run typecheck` / `npm test -- --run`（10 文件 133 测试）/ `npm run build` 全通过。
剩下的都是**必须在真实浏览器里看一眼**、或明确推迟的东西：

### 只能眼验的部分（仓库里没有 jsdom，`useMarquee` 与 `ViewScrollbar` 无法单测）

本轮（2026-09-24，AI 整理）——**已用假 API 在浏览器里跑通**：右键入口、面板、流式、工具行展开、
自动执行、删除必审、按批回退（2 步同时撤销、对话截断）、刷新后从「历史对话」恢复。
**尚未验证**（需要用户的 key）：

- **真实的官方 API 与真实中转站**。尤其是中转站的流式格式与工具调用支持，是最大的不确定性。
- 扩展环境里的 `chrome.permissions.request` 弹窗（开发服务器里没有权限系统）。
- 1000+ 条对话下真实模型的整理质量与 token 花费。
- 批次提交后网格里的短暂高亮（开发服务器里没看清，需在真扩展里看）。
- 用户消息上的「回到这条消息之前」（按批回退已验，按消息回退只有单测）。

叠放两处修改（2026-09-24）——**已在浏览器里验证**：单击展开、双击只切换一次（格子与折叠按钮都是）、
选中一摞时预览栏显示这一摞的信息。

上一轮（2026-09-22，叠放）待眼验项——**整套叠放 UI 与动画都没有单测覆盖**：

- 选中若干对话 → 右键「叠放」→ 折起来那一下的 `stack-fold`；摞上三张卡的倾角
  （3° / −2°）在 `--cell-w` 最大值 256px 下**不被 `content-visibility` 的绘制
  裁剪切掉**（理论余量：3° 探出约 7px，padding 12px）。
- 悬停一摞时三张卡**扇开**（6° / −4°）；右下角计数药丸变 accent 色。
- 点一下摊开：原位置变成**虚线折叠按钮**，成员紧跟其后逐格 `stack-fan` 飞出
  （`--i` × `--stack-step`，11 格封顶）；成员格子是**点线边框**而不是底色。
- 再点折叠按钮收回去。双击一摞 = 同样的展开/折叠，不会打开最上面那条对话。
- 名称默认是时间段（同一天 → 今天/昨天/日期；跨天 → `3月1日 – 3月5日`）；
  摊开时名称下面多一行「N 个项目」。
- 重命名一摞（F2 / 右键）；把名字清空 → 回到派生的时间段。
- 「查看 ▾」→「按日自动叠放」：打开后每天一摞，手工的摞被盖住；关掉就回来。
  打开时右键菜单的「叠放」变成一句灰色说明。
- 把一条对话拖到一摞上 = 加入这一摞（自动叠放的摞**不应该高亮**）。
- 选中一摞后 Del / Ctrl+X / 拖走 → 作用于摞里所有对话，不是只有代表卡那条。
- 撤销：叠放 / 取消叠放 / 加入 / 移出 四个动作都能 Ctrl+Z 回去。
- `prefers-reduced-motion` 打开时上述动画全部瞬时完成（令牌层归零，不单独写媒体查询）。

上一轮（2026-09-19 第三批）待眼验项：

- 详情视图列头右缘可拖宽（无视觉提示，只有 `col-resize` 光标）；双击复位；
  宽度按文件夹记住；**拖完那一下不会顺手把列表重排**。
- 选中态改成命令式之后仍然处处正确：复选框的勾、Ctrl+点击、Shift+范围、Ctrl+A、
  方向键移动、切换文件夹回来、右键菜单里的操作。
- 点空白处清除选择现在发生在 **pointerup**（视觉上仍是瞬时）；
  「框选一些之后，再立刻框选其他」不再卡。
- 历史记录面板：`...` → 历史记录；点行跳转、右键菜单两个方向的措辞、
  当前行/已回退行的样式、跳转后 toast 的步数对不对、底部「初始状态」行。
- 彻底删除文件夹会**连带**删掉子文件夹与其中的对话；「已删除」里按 Del 是彻底删除
  且有确认；「已删除」下钻进去的面包屑挂在「已删除」而不是「文件夹」下。
- 模型排序：Haiku < Sonnet < Opus < Fable，同系列内按版本号。
- 「根目录」与「未归档」的位置：未归档永远第一，左栏「文件夹」最靠左。

上上轮（2026-09-19 第二批）新增待眼验项：

- 滑块两端是**圆头**而不是尖头（`::before { inset: 0 3px }` 半径落在实际条带上）。
- 轨道上界**停在吸顶标题下方**，图标视图与详情视图都不再穿过去
  （`measure()` 改用 `getBoundingClientRect` 波段判定，绕开 Blink 的 `offsetTop` 陷阱）。
- 吸顶状态的 group 标题底色**延伸满宽**（`.is-stuck::before { right: 0 }`），
  未吸顶的标题右端**没有三角尖尖**（底色与细线搬到独立 `::before`，不再有相邻边框斜接）。
- 1296 条下反复框选、切换文件夹**不再卡**（框选全程不进 React）。
- 拖任何东西都不卡死：拖文件、拖**选中的文字**、从桌面往里拖文件。
- 拖宽左右分隔条时只有**一条略深的 1px 细线**，没有加粗橙条。
- 菜单勾选改为 Windows 风格的**圆点**（视图菜单、排序菜单、`Select` 下拉都是同一套）。
- 详情视图**每组第一行**的选中描边不再被表头切掉。
- 导航树选中项**不加粗**；状态栏不再有 `xxx left to file`。

上一轮遗留的眼验项（仍有效）：

- 自绘浮层滚动条：拖拽、滚轮转发、轨道区域可起框选。
- 两根分隔条（导航树 / 预览栏）拖宽、双击复位、方向键微调、宽度持久化。
- 图标视图的二维方向键（列数来自 `getComputedStyle(grid).gridTemplateColumns`）。
- 同步从 3 分钟降到约 15 秒。

### 仍然推迟、尚未实现的子功能

- 自由布局视图（free layout）。
- 备份**导入**（只做了导出）。
- HTML5 拖拽过程中的自定义自动滚动（只用浏览器默认行为）。
- 右键菜单中快捷方式的「重命名」为禁用状态。
- 水平滚动条：改自绘竖条后 `scrollbar-width: none` 是全轴的，横条一并没了；
  靠 `.icon-grid` 的 `minmax(min(var(--cell-w), 100%), 1fr)` 保证不会横向溢出，
  详情视图 name 列 `flex:1; min-width:0` 同理。真要横向滚动得再补一条自绘横条。

---

## 5. 自裁定偏差登记（已全部汇报给用户）

早期几轮：滚动条深色 hover 调亮；fable 前景 `#e09468`；去掉「纹理」缩略图档；
角标始终浮动；不做手工虚拟化改用 `content-visibility`；详情视图补全四种状态样式；
图标视图展开的名称改为**向上**生长（与早期「不盖住图标」的说法相反，取舍是宁可
压到图标一点也不要把下一行推开）；缩略图正文从 `**Conversation Overview**` 之后
起算；预览栏支持 Markdown；计时 toast 改为 debug 开关控制；下拉框全部自绘；
排序改自然序（数字段按数值比）。

本轮（#20–#27）：

1. 竖向滚动条改为**自绘浮层**（`src/app/scrollbar.tsx`），原生条关掉；副作用见 §4。
2. 新增 `--danger-solid` / `--danger-solid-hover` 一对 token，与作为前景色的
   `--danger` 分开——深色的 `--danger` 配白字只有 2.93:1，达不到 AA。
   已用 `tokens.test.ts` 锁住 ≥4.5:1。
3. 导航树也做成可拖宽（DESIGN §2.3 只提了预览栏）；预览栏范围严格取规范的
   240–480px，导航树自定为 160–420px。
4. 方向键走到网格边界**停住**，不折行、不环绕。
5. 「已改名」铅笔改为按内容判定（`isRenamed`），提交时把等于远端标题的别名归一化为
   `null`——两处都改是因为历史数据里已经存在「别名 == 远端名」的记录。

本轮（2026-09-19，#28–#36）：

6. `.group-header` 的底色与 1px 细线搬到 `::before` 图层，元素自身不再有
   `border-right`/`background-clip`。副作用是 padding 在吸顶与未吸顶两态下**恒定**，
   标签文字不会再在吸顶瞬间横移。
7. 分隔条的拖拽反馈定为**分隔条所在那条 1px 边框变深**（`--border-strong`），
   不是整条 5px 命中区变色——用户只要「略微变深」，这是最贴近原生的做法。
8. 视图菜单的 Icons / Details 两行从 `disabled` 改为**用圆点标记当前项**。
   原本禁用当前项会让它看起来「不可用」，与「这是选中的」语义相反。
9. `Select` 下拉里的对勾图标也一并换成同一个圆点，保证整个产品只有一套选中词汇。
10. `.details-row` 改为统一 `margin-top: 3px`，删掉 `.details-row + .details-row`。
    原规则跨不过分组容器，导致每组第一行贴着表头 / 上一组，焦点环被切。
11. `unfiledRemaining` 从 i18n **两本字典里都删掉**，而不是只在渲染处隐藏——
    没有任何调用方了，留着就是死键。
12. 导航树补上了它一直没有的 `dragleave`：原先把文件拖进导航树再拖走，
    高亮会永久卡住。属于顺手修的潜在 bug，用户没提。
13. 框选**全程不经过 React**：拖动时直接改 DOM class 与 `input.checked`，
    只在 pointerup 时 `onCommit` 一次。这是「卡顿没有根本性解决」的真正根因——
    每帧两次 `setState` × 1296 个子节点的 reconcile。

本轮（2026-09-19 第二批）：

14. **原生拖拽也全部改为命令式**。`draggingKeys` / `dropFolderId` 两个 state 删除，
    `is-dragging` / `is-drop` 由 App 直接写 `classList`；`ViewProps` 去掉
    `dropKey`/`draggingKeys`，`NavTreeProps` 去掉 `dropFolderId`，`Flags` 只剩
    `selected/cut/focused/editing`。一个无依赖数组的 `useEffect` 在每次渲染后把
    这两个类**重新刷一遍**（自愈），空闲时的代价是一次 `Set.size` 判断。
15. `FolderIcon` 不再接 `dropTarget`，落点描边改由祖先 `.is-drop` 的后代选择器给。
    `.folder-icon.is-drop` 的旧选择器保留，因为 showcase 要孤立地展示这个状态。
16. 新增 token **`--border-active`**（浅 `#bdb4a0` / 深 `#4a4841`）。分隔条原先用
    `--border-strong`，但它在浅色下是 `#141413`，近乎纯黑——用户要的是「微微变深到
    浅褐色」。`--border-strong` 保留给详情视图列头那种需要字重感的分隔线。

本轮（2026-09-19 第三批，对应用户 11 条意见）：

17. 彻底删除的对话**不留墓碑**，下次同步会从服务器回来——确认框里明说了这一点。
    真要做墓碑得存一张"已拒绝的 uuid"表，那是同步语义的改动，不是删除语义的。
18. `purgeRefs` 不再在目标尚未进回收站时抛错，改由 UI 把关（「已删除」视图之外
    根本不提供这个动作）。
19. `compareModel` 由降序翻成**升序**，`SERIES_RANK` 重编号为 `other:0 … fable:4`，
    `sortItems` 里那个 `-compareModel` 的取反随之删掉。原先"升序 = 等级最低在前"
    是靠两次取反凑出来的，读代码的人必然被绕进去。
20. 新增 `naturalAsc(key)`：**切换排序键时重置为该键的自然方向**（名称升序、日期
    降序），和资源管理器一致；只有点同一个键才翻转方向。
21. `navFolders` 拆成 `navRoot` + `navFolders`；根节点**不画文件夹图标**，好和上面的
    快速访问对齐。
22. 「未归档」**同时**出现在快速访问和文件夹树里，且在两处都置顶。它确实是一个真实
    文件夹，也确实是最常去的地方，两个身份都给它。
23. 「定位到原文件」不只给快捷方式：**任何在自己文件夹之外被列出来的对话**都给
    （搜索结果、最近、已标记…）。用户只提了快捷方式，但同一个动作在这些场景下
    意义完全一样。
24. Esc 的优先级定为：**先取消剪切，再清除选择**。两件事都用 Esc，得有先后。
25. `.paper-footer` 右侧预留 `badge + 4` px，避免右下角的快捷方式箭头压住模型标签。
26. 顺手修掉了快速跳转（Ctrl+G）跳转后丢失选中的老 bug，用户没提。
27. **详情列宽按文件夹视图保存**（`FolderView.columnWidths`，稀疏），并以
    CSS 自定义属性 `--col-<key>` 下发；**双击手柄复位该列**——这是用户没要、但几乎
    零成本的一个附赠动作。
28. **`is-selected` 与复选框的勾离开 React 渲染输出**，和 `is-dragging`/`is-drop`
    一样改为命令式绘制；`ItemCheck` 因此变成非受控输入。刷新用的是
    `useLayoutEffect`（被动 effect 不保证在绘制前跑完，会闪一帧），并在拖拽进行中
    跳过（`marquee.isLive()`，否则会把过时的选择集盖到拖拽结果上）。
29. **点空白处清除选择改在 pointerup 通知 React**（视觉上仍是瞬时的命令式擦除）。
    这才是 #10「框选一些之后再立刻框选其他」卡顿的第二个根因。
30. **「回退」不作为新的日志条目记录**（用户原话是要记）。理由写在 DESIGN §8.10：
    把撤销记成动作会无限递归。改为「日志是直线 + 游标标记你站在哪」，用户要的三个
    能力（看全部动作 / 回到某个动作之前 / 取消回退）一个不少，而且退回去再走回来
    能精确复原。唯一动词是 `ops.jumpTo(seq)`。
31. 历史记录面板**自己读自己的数据**，不挂进 `useAppData`——否则每次写入都要顺带读
    最多 200 条事务记录去喂一个绝大多数时间关着的弹窗。
32. 历史跳转**不做二次确认**（跳转可逆），只弹一条**不带撤销按钮**的 toast 报步数。

本轮（2026-09-22，叠放）：

33. **叠放不是文件夹**，是"在对话本来所在的文件夹里把它们视觉上折起来"。
    `Chat.folderId` 不动，成员在读取时解析，解析不到就不画。代价是
    `Stack.members` 里会留下已失效的键——这是刻意的，换来的是移动/删除/同步/撤销
    全都不必知道叠放存在。
34. **单条的那一天在自动叠放下保持散开**，不会变成"一摞一个"。与 `STACK_MIN_MEMBERS`
    一致，但与 macOS 略有出入（macOS 会堆一个）。
35. **展开状态只存在于会话中，且按位置分键**。自动叠放的 id 只在这份列表存在期间
    有意义，持久化只会往库里塞死键。
36. **一摞的"代表卡"是最新的成员**，`item.chat` 指向它。排序/分组/预览栏因此零改动
    工作，代价是真想表达"这一摞"的代码必须先看 `ref.kind`。
37. **新增图标 `layers` / `layersOff`**（Icon.tsx）。
38. **自动叠放开启时，右键菜单的「叠放」变成一句说明并置灰**，而不是禁用一个
    不解释原因的按钮。
39. **一摞被选中时，所有动作（移动/删除/剪切/拖拽/标记）作用于它的成员**——
    `expandRefs` 在 `selectedRefs()` 这一个收口处展开。与 macOS 拖一摞 = 拖里面的
    文件一致。
40. **选中一摞 + 几个散的再叠放 = 合并，不是嵌套**（`stackableKeys`）。
41. ~~预览栏对一摞显示的是代表卡那条对话~~ —— **2026-09-24 按用户要求改掉**：
    选中一摞时显示 `StackPreview`（这一摞的信息）。同一轮还改成了**单击就展开**。
42. **一摞接受拖放，语义是「加入这一摞」而不是「移动进去」**；自动叠放的摞
    连高亮都不给，因为它根本没有记录可以加。
43. `src/app/App.tsx` 里曾混进两个**字面 NUL 字节**（分组折叠键的分隔符直接打成了
    实际的 U+0000），导致 Grep 把它判成二进制文件、Edit 工具匹配失败。已全部改回
    `\u0000` 转义。**以后写分隔符一律用转义。**

本轮（2026-09-24，AI 整理 + 叠放两处修改）：

44. **面板停靠在预览窗格的位置，不用模态框**。整理的意义就是看着文件夹变化。
45. **写入只有一个工具 `apply_changes`，一次调用 = 一批 = 一步撤销**，一批里可以同时建文件夹并移入。
46. **两种接口格式都支持**（Anthropic / OpenAI 兼容），另有认证方式覆盖（部分 Anthropic 格式中转站要 Bearer）。
47. **自动执行默认开**，面板底部和设置里都能关；**删除无论开关都要确认**（红色「确认删除」）。
48. 只选了对话时，**允许新建文件夹**（用户只说了「移动到其他文件夹」）——新增是可撤销的、只加不改。
49. **对话记录不走 data port**：它不是库数据，广播每个回合会让其它标签页白白重读整个索引。库的修改仍走 port。
50. **AI 配置（含 key）存在单独的 meta 键**，不放进 `Settings`，保证它不会随设置导出。
51. 网络权限用 **`optional_host_permissions` 按域名按需申请**，不在安装时要「所有网站」。
52. 工具输出给模型看的是**英文**，界面上的行摘要和预览走 i18n。
53. **旧的读取结果折叠成一行摘要**再发给模型；界面上仍可展开原文。
54. 官方接口打 prompt caching 标记，**中转站不打**（避免不兼容）。
55. 新增图标 `sparkle` / `rewind` / `stop` / `eye`。
56. **双击一摞只切换一次**（连击第二下被忽略），折叠按钮和计数角标也一样——否则单击展开会被双击抵消。
57. 顺手修的：`onSyncProgress` 在非扩展环境下不再崩溃，App 页面第一次能在开发服务器里打开。
58. 顺手修的：`D:\Desktop\.claude\launch.json` 里的 `chatexplorer-showcase` 改指向新目录。

本轮（2026-09-24 第二批，用户同意「整理偏好 / 推断现有习惯 / 偏好跨对话积累」，否决「强制先定方案」）：

59. **整理偏好存在 `AiConfig.preferences`**（和 key 放一起，不进 Settings、不进备份），
    以 `<preferences>` 块放在系统提示词里、排在默认做法之前，明写「压过默认」。
60. **`remember_preference` 无论「自动执行」开关都要确认**——它改的是以后每段对话听到的话。
    不进撤销记录（改配置不改库），回退对话也不会撤掉已记住的偏好；要删就在设置里删。
61. **提示词里的偏好每一轮都现读**，不用循环开始时捕获的配置——对话中途记住的偏好下一轮就生效。
62. **所有右键菜单的标签改为单行 + 省略号**，菜单宽度取内容宽（上限 360px），好让边缘翻转
    把整个菜单挪进视口。历史对话把时间放进右侧的次要位，保证被截掉的是标题而不是时间。
63. 审美约束写进了提示词（回复不用 emoji / 感叹号 / 客套；命名规范）。方法论还在和用户讨论，**尚未写入**。
64. `version` 这个 i18n 键原本就在（「版本号」），之前没人用；这次直接用它，没有新增重复键。
65. **Bash 工具会吃掉 heredoc 里的反斜杠**（`\s` 变 `s`，`\n` 变真换行），本轮在 runner.ts 里踩过一次。
    含反斜杠的批量替换一律写成 scratchpad 里的 .cjs 文件再用 node 跑。
    另：`String.replace` 的替换串里 `    含反斜杠的批量替换一律写成 scratchpad 里的 .cjs 文件再用 node 跑。` 会被解释（插入被匹配的原文），替换文本里有 `# ChatExplorer — 项目进度与约定

> Edge (MV3) 扩展，用文件管理器式的 UI 替代 claude.ai 的 1296 条会话平铺列表。
> 索引完全本地。设计规范在 `D:\Downloads\DESIGN.md`（已跟到 2026-09-24）。
> **对话用中文。**
>
> **工作目录（2026-09-24 起）：`D:\Desktop\ChatExplorer Another\`**。旧目录
> `D:\Desktop\ChatExplorer\` 已弃用：另一个 session 在那里留下了一个编译不过的
> 半成品 AI 整理功能。本目录是叠放做完时的干净状态，AI 整理功能在这里从头重做。
> Edge 里加载的解压扩展要改指向本目录的 `dist`。
>
> 最近一轮的详细交接见根目录的 [`HANDOFF.md`](HANDOFF.md)。

---

## 0. 不可违反的硬约束

1. **claude.ai 只读，永不回写。** 本地重命名、标记、文件夹、隐藏状态全部只存在本地 IndexedDB。
2. **测试配额**：需要真实 claude.ai 测试时最高用 Sonnet，Opus 一次会话最多两次；测试消息越短越好（「回复ok即可」这种）；优先开新对话而不是接长对话；能用网络/DOM 检查解决的就不要真的跑补全。
3. **绝对不要 `ConvertFrom-Json` Edge 的 `Preferences` 文件** —— 解析会失败并把约 580 KB 个人资料倒进输出（之前泄漏到 `bz1dkmrg1.txt`，已提示用户删除）。
4. 文件系统语义：每个会话有且只有**一个**真实位置；快捷方式是别名且带可见标记；`Ctrl+C` = 复制为快捷方式，`Ctrl+X` = 移动。
5. UI chrome 中**不出现 emoji**（用户数据里的 emoji 原样透传）；所有数值取自 CSS 变量；所有 UI 文案走 i18n；所有对话框/toast 自绘，**绝不用浏览器原生 confirm/alert**；删除必须二次确认；删除 = 隐藏状态（软删除）。
6. 设计规范允许灵活调整，**但每一处偏离都必须告知用户**（用户原话：「后续只需告知」）。

## 0.1 用户已确认的决策（正在实现）

- UI 可以直接读 IndexedDB，但**写入只有一个入口**，并通过 BroadcastChannel 广播；data-port 接口保留。
- 搜索 = 全量扫描 + 大小写与全角/半角归一化。
- 详情视图**默认 compact**（单行、仅标题）；comfortable 多显示一行摘要。
- 撤销：一次手势 = 一步，无合并窗口。
- 偏差 1–9 + 「同步时保留隐藏状态」+「隐藏按祖先解析」：全部批准，需写回 DESIGN.md。
- 缩略图只有两档（<90px 画线条，≥90px 用 10px 字号可读）；模型标签按图标 12% 缩放、永不省略号、<48px 隐藏；标记竖向堆叠、16px 上限；文字避开折角。
- 图标视图：选中项名称展开时图标保持可见，名称向下生长；drop 状态只出现在文件夹上。
- 详情视图：行间距 2px，独立圆角 hover/选中块，内缩 4px。
- 框选：**所有视图**（含详情视图）都支持，Ctrl+拖拽为追加，靠近边缘自动滚动。
- 深色主题完整重调（#1A1A18 / #211F1D / #2C2A27 / #2F2D29 / #3D3830，纸面 #2E2C28 / #4A4640 / #3A3833，文件夹 #A8864F / #7E6440，标签对比度 ≥4.5:1）。
- 滚动条全部自绘：8px → hover 10px，无轨道，全圆角，Firefox 用 scrollbar-color。

---

## 1. 文件地图（初建于 2026-09-17，表内签名持续更新）

### `src/app/`

| 文件 | 内容 |
| --- | --- |
| `dataport.ts` | **唯一写入入口**。`onDataChanged(fn)` 订阅；`notify()` 通知本地监听者 + `BroadcastChannel("chatexplorer-data")` 扇出；`writes()` 包装器。导出 `port`（30 个动作，全部带 notify）：<br>文件夹 `createFolder / renameFolder / moveFolder / setFolderHidden`<br>回收站 `purgeRefs / restoreRefs / setChatsHidden`<br>会话 `setChatsFlagged / moveChats / renameChat / setNotes`<br>快捷方式 `createShortcuts / moveShortcuts / deleteShortcuts`<br>**叠放 `createStack / dissolveStack / renameStack / addToStack / removeFromStack`**<br>**AI 整理 `applyAgentOps / jumpBefore / saveAiConfig`**<br>其它 `setPositions / undo / redo / jumpTo / saveView / resetView / saveSettings / sync` |
| `model.ts` | 纯视图模型层（无 IndexedDB、无 React），666 行。`VirtualId` / `Location` / `locationKey` / `sameLocation` / `Item` / `StackInfo` / `itemKey` / `subtreeIds` / `normalizeForSearch` / `makeListContext` / `listItems` / **`autoStackId` / `foldStacks` / `stackableKeys` / `stacksOf` / `isAutoStack`** / `naturalAsc` / `sortItems` / `groupItems` / `refsToChatUuids` / `countsFor`。<br>**管线顺序是 `listItems → sortItems → foldStacks → groupItems`**，不能改（见 §7）。 |
| `app.css` | Shell 布局：`.app` / `.app-toolbar` / `.app-main`（nav 220px / content / preview 300px）/ `.view-scroll`（共享滚动容器，marquee 的坐标系，position:relative）/ `.icon-grid` / 单元格与行的 `content-visibility: auto` + `contain-intrinsic-size` / `.rename-input` / 预览面板 / 遮罩、菜单、toast、picker、设置面板。 |
| `useAppData.ts` | 并行加载 `snapshot()` + `loadViews()` + `loadSettings()` + `historyState()` + `getMeta(lastSyncAt)`；订阅 `onDataChanged`；挂载时 `requestAuth`；`runSync()` 管理 syncing / syncError 并在同步后复查登录态。 |
| `overlays.tsx` | `ConfirmDialog`（遮罩点击/Esc 关闭，确认按钮自动聚焦）、`ToastHost`（5 秒自动过期）、`ContextMenu`（视口翻转，外部 mousedown / Esc / blur 关闭）、`Picker`（输入 + ↑↓/Enter/Esc，上限 100 条）、`SettingsPanel`。 |
| `views.tsx` | `IconView` / `DetailsView` / `ItemHandlers` / `ViewProps` / `cellClass()` / `RenameInput`。详情列宽 `COL_WIDTH = {updatedAt:150, createdAt:150, model:110, location:190, starred:56}`，name 列 flex:1；表头点击排序走 `onSortBy`。 |
| **`useMarquee.ts`** | **框选，全程不碰 React**。`useMarquee(scrollRef, { getSelection, onCommit })` → `{ start(e), rectRef }`。rAF 循环：矩形用**内容坐标**（与滚动无关），由 `rectRef` 指向的常驻 div 直接写 `style` 移动；命中项用 `classList.toggle("is-selected")` **命令式上色**（比对 DOM 而非记忆集合，App 若中途重渲染下一帧会自愈）；只有 pointerup 时 `onCommit(keys)` 把结论交给 React **一次**。边缘自动滚动 `EDGE = 28px` / `MAX_SPEED = 18`；盒子缓存 `REMEASURE_MS = 120` 节流；**4px 死区**（未越过死区不 commit，那是一次点击）；起始时按住 Ctrl/Meta = 与起始选择集求并。 |
| `chrome.tsx` | `NavTree`（虚拟节点 unfiled→inbox / recent→clock / flagged→bookmark / starred→star / missing→unlink / hidden→eyeOff + 计数，文件夹树、拼音排序、拖放目标）、`Toolbar`（前进/后退/上一层、面包屑、搜索框、视图/排序/新建/同步/预览/更多）、`StatusBar`、`PreviewPane`（标题、官方标题、元信息、笔记草稿 blur 保存、打开/移动按钮）、**`StackPreview`**（选中一摞时替代 PreviewPane：时间段、成员数、位置、模型分布、成员列表、展开/取消叠放）。 |
| `App.tsx` | **完整 shell，2145 行**。导航历史、选择、剪贴板、编辑、拖放、键盘、右键菜单、Picker、设置、toast、叠放、AI 面板的开关与网格高亮全在这里；视图只收 props。 |
| **`agent-panel.tsx`** | AI 整理面板（653 行）。占预览窗格的位置；状态全在 `AgentRunner` 上，`onChange` 按 rAF 节流重渲染，**不会**重渲染 App。`UserTurn` / `AssistantTurn` / `ToolRow`。 |
| **`agent-settings.tsx`** | 设置面板里的「AI 整理」一节 + 共用的 `apiErrorText()`（每种失败一句能照做的话）。 |
| **`model.test.ts`** | 单元测试，**29 个用例**（详见 §2）。 |

### `src/agent/` —— AI 整理（2026-09-24 新建，全部纯逻辑 + 一个 I/O 文件）

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `AiConfig` / `AgentScope` / `Turn` / `Block`（`TextBlock` \| `ToolBlock`）/ `Session`。**工具调用和它的结果存在同一个 block 里**，发请求时才拆成两条消息。 |
| `scope.ts` | `resolveAccess(scope, snap)` → `Access`（`canReadChat / canWriteChat / canReadFolder / canMoveInto / canCreateIn / canEditFolder`）。**权限边界在这里用代码强制**。三种模式：all / folders / chats。 |
| `ids.ts` | `IdRegistry`：UUID ↔ `c12` / `f3` 短编号，懒分配、随会话持久化、永不复用。 |
| `tools.ts` | 4 个读工具（`get_overview` / `list_chats` / `search_chats` / `read_chats`）+ 1 个写工具 `apply_changes`（一批 = 一步撤销）+ `remember_preference`（提议记住一条偏好，永远要用户确认，不是撤销步骤）。`planChanges()` 是把不可信的模型输出变成 ops 的地方。 |
| `context.ts` | `buildMessages(turns)`：拆 tool block、给没跑完的调用补结果、**旧读取结果按总量折叠**（`READ_BUDGET = 120_000` 字，超出才从最旧的折叠）。 |
| `rewind.ts` | `planRewind` / `rewindStatus` / `stepState`，纯函数。 |
| `providers.ts` | 两种接口格式的请求构造 + 流式事件映射 + `Assembler`；`endpointUrl()` 解析用户随手粘的地址。 |
| `sse.ts` | 增量 SSE 解析器（容忍 CRLF、无 event 行、任意位置断包）。 |
| `client.ts` | **唯一碰网络的文件**。`streamChat` / `testConnection` / `ApiError`；400 时按报错文本定向重试一次（`max_completion_tokens` / `stream_options`）。 |
| `config.ts` | `loadAiConfig` / `saveAiConfig`（单独的 meta 键 `aiConfig`）/ `ensureHostPermission`（按域名申请 optional 权限）。 |
| `sessions.ts` | 会话与回合的 IndexedDB 读写。**不走 data port**（见偏差 #49）。 |
| `prompt.ts` | 系统提示词；刻意不含会变的数字，便于缓存。 |
| `runner.ts` | `AgentRunner`：`send` / `resume` / `stop` / `decide` / `rewind`。 |

### 其它目录里与本项目约定强相关的文件

| 文件 | 内容 |
| --- | --- |
| `src/core/schema.ts` | **`DB_VERSION = 4`**（v4 = `agentSessions` + `agentTurns` 两个存储；`META_KEY.aiConfig`）；`Folder` / `Chat` / `Shortcut` / **`Stack`** / `FolderView` / `Settings`；`STACK_MIN_MEMBERS = 2`；`AutoStackKey = "off" \| "day"`。 |
| `src/core/db.ts` | 升级链 `migrateToV2` / `migrateToV3`（`stacks`）/ **`migrateToV4`**（`agentSessions` keyPath `id`；`agentTurns` 复合键 `[sessionId, idx]`）。 |
| `src/core/ops.ts` | 撤销原语与逆操作。**9** 个原语：`folder.put/del`、`chat.put/patch/del`、`shortcut.put/del`、`stack.put/del`。**`MAX_LOG = 1000`**；`commit` 返回 seq；新增 `jumpBefore(seq)` / `logIndex()`。 |
| `src/core/store.ts` | 25 个变更函数，全部写事务日志（新增 `applyAgentOps`）；`uniqueName` 已导出。 |
| `src/core/settings.ts` | 新增 `agentWidth` 与 `PANE_LIMITS.agent`（320–720，默认 400）。 |
| `src/ui/markdown.tsx` | 新增 `summaryHead(md, maxChars)`：简介第一段的纯文本。 |
| `src/ui/format.ts` | `displayName` / `firstSentence` / **`dayKey`（本地日，不是 `iso.slice(0,10)`）** / **`rangeLabel`**。 |

### 2026-09-17 那一轮对既有文件的改动（存档）

- `src/app/main.tsx` —— **已改为挂载新 shell**：`createRoot(...).render(<StrictMode><App /></StrictMode>)` + `import "./app.css"`。旧的 debug shell 与 `styles.css` 引用已移除（`src/app/styles.css` 现在是孤儿文件，可删）。
- `src/core/schema.ts` —— `defaultView()` 的 density 由 `"comfortable"` 改为 `"compact"`。
- `src/core/settings.ts` —— `DEFAULT_SETTINGS.defaultDensity` 改为 `"compact"`。
- `src/ui/i18n.ts` —— 新增 `close` 键（en: `"Close"` / zh-CN: `"关闭"`），供设置面板关闭按钮使用（此前是硬编码 "OK"，违反 i18n 规则）。
- `src/app/app.css` —— 补齐 `.details-row` 的 `is-drop` / `is-dragging` / `is-focus` / `is-cut` 状态样式（此前只有 `.grid-cell` 有，详情视图共用同一套选择机制却没有对应视觉）。

### 长期有效的编译约束（存档：下列改动早已被编译器确认）

tsconfig 开了 `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals` +
`noUnusedParameters`。**写新代码时这四条一直都在**，尤其 `noUncheckedIndexedAccess`
会让任何 `arr[i]` 变成 `T | undefined`。2026-09-17 据此排查出的几处：

- `App.tsx`：`formatWhen()` 去掉未使用的 `t` 参数；删除 `void ICON_SIZE;` 占位 hack 与 `ICON_SIZE` 导入。
- `App.tsx`：`hist.stack[hist.index] ?? HOME`；`navigate()` 内 `current &&` 判空；`selectedChatItems[0]?.chat`。
- `overlays.tsx`：`Picker` 的 Enter 分支改为先取 `const hit = shown[clamped]` 再判空。
- `useMarquee.ts`：`state.current` 的类型收窄在 addEventListener 之后会失效，改为先赋给局部 `st` 再用 `st.raf = requestAnimationFrame(frame)`。

---

## 2. `src/app/model.test.ts` 覆盖范围

纯对象输入输出，仿照 `src/core/store.test.ts` 的 fixture 风格（`folder()` / `chat()` / `shortcut()` / `snap()` / `ctxOf()` 工厂，`translator("en")`）。用例：

1. `normalizeForSearch` 全角字母数字折叠、U+3000 表意空格 → 半角空格、中文不变。
2. `locationKey` / `sameLocation` 三种 Location 互不混淆。
3. `subtreeIds` 包含自身且深度递归。
4. 文件夹视图列出子文件夹 + 会话 + **存活的**快捷方式（目标被隐藏或已消失的快捷方式跳过）；隐藏文件夹不出现在父级。
5. 隐藏文件夹内的会话在所有虚拟视图与计数中不可见；「已删除」视图只列**顶层**隐藏项，不列其子树（避免误导性的局部恢复）。
6. `recent` 遵守 `recentCount` 且按 updatedAt 倒序。
7. 搜索：全角折叠、扫描 notes、scope 子树限制、匹配文件夹名、空查询返回空。
8. 排序：文件夹永远在前；日期排序下文件夹块仍按名称排；升降序翻转会话顺序但**不翻转**文件夹块。
9. 分组：`none` 产生单个无标签组；`month` 按 updatedAt 分桶且文件夹单独成组。
10. `refsToChatUuids` 解析快捷方式目标并去重，忽略文件夹 ref 与失效 ref；
    **传入 `stacksOf(items)` 时能把一摞展开成全部成员**，不传则安全地返回空。
11. `countsFor` 只统计可见会话；`hidden` 计数 = 隐藏会话 + 隐藏文件夹。

叠放（2026-09-22 新增 10 例）：

12. 存储的一摞折成一格，默认名是成员的时间段；手输的名字盖过派生名。
13. 只剩一个成员还在的一摞**散开渲染**，不做「一摞一个」。
14. 展开后成员紧跟在折叠按钮之后，`inStack` / `stackIndex` 正确。
15. 按日自动叠放**盖过**存储的手工叠放；详情视图永不折叠。
16. **文件夹永远不会被吞进一摞**（三处过滤用同一个 `foldable` 谓词）。
17. 一个 stack ref 解析为摞里的每一条对话。
18. `stackableKeys`：选中一摞 + 一条散的 → 合并成三条，不嵌套；文件夹被剔除、重复项折叠。

### 其它测试文件

`src/core/store.test.ts`(23) / `src/claude/sync.test.ts`(13) / `src/ui/markdown.test.ts`(8) /
`src/core/model.test.ts`(4) / `src/ui/format.test.ts`(4) / `src/ui/tokens.test.ts`(1)；`markdown.test.ts` 现为 9（+ 编号列表跨段保号）。

AI 整理（2026-09-24 新增 43 例）：

- `src/agent/agent.test.ts`(27)：搜索（`|`/`OR`、英文整词、标题优先）、只看标题一页 500 条、按总量折叠、提示词里偏好的有无与位置、短编号、三种范围、读工具输出格式、`planChanges` 的全部动作与拒绝路径、
  「权限按原始记录判定」、消息拆分与折叠、回退计划与状态。
- `src/agent/providers.test.ts`(9)：地址解析、两种流式格式（乱切数据块、CRLF、并行工具调用、
  被截断的参数、流中错误、忽略 stream 的中转站）、两种请求体。
- `src/agent/runner.test.ts`(10)：记住偏好（总要确认、去重、拒绝不存）、**用脚本化的假 API + fake-indexeddb 端到端**跑循环：一批 = 一步、
  审批闸门、删除必审、停止、HTTP 错误、重试、轮数上限、回退。
- `store.test.ts` +3：`jumpBefore`、`logIndex`、`commit` 返回 seq。

合计 **10 个文件 / 133 个测试**。

---

## 3. 当前状态（2026-09-24 更新）

**版本 0.2.0**（manifest 与 package.json 同步；设置 → 关于 里显示，读自 manifest）。
manifest 描述已改：旧描述「Folders and names are stored locally only」在有了 AI 整理之后
不再完全准确——使用它时，对话标题与简介会发往用户自己配置的接口。

`npm run typecheck` / `npm test -- --run`（**10 个文件 / 133 个测试**）/ `npm run build`
三件套全部通过。DESIGN.md 回写已跟到 2026-09-24 这一轮（新增 §11.2 AI 整理；§4.3.1 叠放加两条修订）。

注意事项：

- Bash 工具的 cwd 是 `D:\Desktop`，**不是项目目录**（2026-09-22 复核仍然如此：
  每个新会话都会重置回去，虽然同一会话内 `cd` 会保持）。跑脚本一律先
  `cd "/d/Desktop/ChatExplorer Another"`（**路径里有空格，必须加引号**），**不要**写
  `cd /d D:\...`（Bash 是 git-bash，会报 `cd: too many arguments`）。
- **源码里绝不能出现字面 NUL 字节**。分隔符一律写 `\u0000` 转义——写成真的 U+0000
  会让 Grep 把整个文件判成二进制、Edit 工具匹配失败，而 Read 却一切正常，
  非常难查。2026-09-22 在 `App.tsx` 里踩过一次。
- Edit 工具拒绝编辑本会话尚未 Read 过的文件（报 "File has not been read yet"），
  先 Read 目标区域再改。
- **不要对本仓库跑 prettier**：没有配置文件，默认风格（80 列、尾逗号）和项目风格
  （100 列、无尾逗号）不一致，跑一次就会把整个文件改花。
- preview 服务器在 `.claude/launch.json` 里叫 `showcase`，但注册表（`D:\Desktop\.claude\launch.json`）
  里的名字是 **`chatexplorer-showcase`**，`preview_start` 要用后者。2026-09-24 已改指向本目录，
  并改成 `node …\vite\bin\vite.js`——路径里的空格会让 `vite.cmd` 在 cmd 下断开。
- **App 页面现在可以在开发服务器里打开**（`http://localhost:5174/app.html`）：`onSyncProgress`
  加了非扩展环境的判断，以前在扩展外直接崩。库是空的，需要用 JS 往 IndexedDB 塞测试数据；
  AI 面板可以接一个本地的假 API（脚本化 SSE，带 CORS）来完整跑一遍而不花钱——本轮就是这样验的。

已通过 Grep 逐一核对过的契约（都对得上，不必重查）：`store.ts` 全部变更函数签名、`ops.ts` 的 undo/redo/historyState/historyLog/jumpTo、`views.ts` 的 loadViews/resolveView/saveView/resetView、`settings.ts` 的 loadSettings/saveSettings、`db.ts` 的 getMeta、`api.ts` 的 `AuthStatus`、`messaging.ts` 的 requestSync/requestAuth、`Icon.tsx` 的全部 IconName、`ChatIcon.tsx` 的 ChatIcon/FolderIcon/ModelTag props、`schema.ts` 的 FolderView/SortKey/GroupKey/ColumnKey、`i18n.ts` 的全部键（代码中用到的键 100% 存在）、`components.css` 的类名清单。

---

## 4. 剩余任务

代码层面 2026-09-24 的 **AI 整理**与叠放两处修改已全部落地，
`npm run typecheck` / `npm test -- --run`（10 文件 133 测试）/ `npm run build` 全通过。
剩下的都是**必须在真实浏览器里看一眼**、或明确推迟的东西：

### 只能眼验的部分（仓库里没有 jsdom，`useMarquee` 与 `ViewScrollbar` 无法单测）

本轮（2026-09-24，AI 整理）——**已用假 API 在浏览器里跑通**：右键入口、面板、流式、工具行展开、
自动执行、删除必审、按批回退（2 步同时撤销、对话截断）、刷新后从「历史对话」恢复。
**尚未验证**（需要用户的 key）：

- **真实的官方 API 与真实中转站**。尤其是中转站的流式格式与工具调用支持，是最大的不确定性。
- 扩展环境里的 `chrome.permissions.request` 弹窗（开发服务器里没有权限系统）。
- 1000+ 条对话下真实模型的整理质量与 token 花费。
- 批次提交后网格里的短暂高亮（开发服务器里没看清，需在真扩展里看）。
- 用户消息上的「回到这条消息之前」（按批回退已验，按消息回退只有单测）。

叠放两处修改（2026-09-24）——**已在浏览器里验证**：单击展开、双击只切换一次（格子与折叠按钮都是）、
选中一摞时预览栏显示这一摞的信息。

上一轮（2026-09-22，叠放）待眼验项——**整套叠放 UI 与动画都没有单测覆盖**：

- 选中若干对话 → 右键「叠放」→ 折起来那一下的 `stack-fold`；摞上三张卡的倾角
  （3° / −2°）在 `--cell-w` 最大值 256px 下**不被 `content-visibility` 的绘制
  裁剪切掉**（理论余量：3° 探出约 7px，padding 12px）。
- 悬停一摞时三张卡**扇开**（6° / −4°）；右下角计数药丸变 accent 色。
- 点一下摊开：原位置变成**虚线折叠按钮**，成员紧跟其后逐格 `stack-fan` 飞出
  （`--i` × `--stack-step`，11 格封顶）；成员格子是**点线边框**而不是底色。
- 再点折叠按钮收回去。双击一摞 = 同样的展开/折叠，不会打开最上面那条对话。
- 名称默认是时间段（同一天 → 今天/昨天/日期；跨天 → `3月1日 – 3月5日`）；
  摊开时名称下面多一行「N 个项目」。
- 重命名一摞（F2 / 右键）；把名字清空 → 回到派生的时间段。
- 「查看 ▾」→「按日自动叠放」：打开后每天一摞，手工的摞被盖住；关掉就回来。
  打开时右键菜单的「叠放」变成一句灰色说明。
- 把一条对话拖到一摞上 = 加入这一摞（自动叠放的摞**不应该高亮**）。
- 选中一摞后 Del / Ctrl+X / 拖走 → 作用于摞里所有对话，不是只有代表卡那条。
- 撤销：叠放 / 取消叠放 / 加入 / 移出 四个动作都能 Ctrl+Z 回去。
- `prefers-reduced-motion` 打开时上述动画全部瞬时完成（令牌层归零，不单独写媒体查询）。

上一轮（2026-09-19 第三批）待眼验项：

- 详情视图列头右缘可拖宽（无视觉提示，只有 `col-resize` 光标）；双击复位；
  宽度按文件夹记住；**拖完那一下不会顺手把列表重排**。
- 选中态改成命令式之后仍然处处正确：复选框的勾、Ctrl+点击、Shift+范围、Ctrl+A、
  方向键移动、切换文件夹回来、右键菜单里的操作。
- 点空白处清除选择现在发生在 **pointerup**（视觉上仍是瞬时）；
  「框选一些之后，再立刻框选其他」不再卡。
- 历史记录面板：`...` → 历史记录；点行跳转、右键菜单两个方向的措辞、
  当前行/已回退行的样式、跳转后 toast 的步数对不对、底部「初始状态」行。
- 彻底删除文件夹会**连带**删掉子文件夹与其中的对话；「已删除」里按 Del 是彻底删除
  且有确认；「已删除」下钻进去的面包屑挂在「已删除」而不是「文件夹」下。
- 模型排序：Haiku < Sonnet < Opus < Fable，同系列内按版本号。
- 「根目录」与「未归档」的位置：未归档永远第一，左栏「文件夹」最靠左。

上上轮（2026-09-19 第二批）新增待眼验项：

- 滑块两端是**圆头**而不是尖头（`::before { inset: 0 3px }` 半径落在实际条带上）。
- 轨道上界**停在吸顶标题下方**，图标视图与详情视图都不再穿过去
  （`measure()` 改用 `getBoundingClientRect` 波段判定，绕开 Blink 的 `offsetTop` 陷阱）。
- 吸顶状态的 group 标题底色**延伸满宽**（`.is-stuck::before { right: 0 }`），
  未吸顶的标题右端**没有三角尖尖**（底色与细线搬到独立 `::before`，不再有相邻边框斜接）。
- 1296 条下反复框选、切换文件夹**不再卡**（框选全程不进 React）。
- 拖任何东西都不卡死：拖文件、拖**选中的文字**、从桌面往里拖文件。
- 拖宽左右分隔条时只有**一条略深的 1px 细线**，没有加粗橙条。
- 菜单勾选改为 Windows 风格的**圆点**（视图菜单、排序菜单、`Select` 下拉都是同一套）。
- 详情视图**每组第一行**的选中描边不再被表头切掉。
- 导航树选中项**不加粗**；状态栏不再有 `xxx left to file`。

上一轮遗留的眼验项（仍有效）：

- 自绘浮层滚动条：拖拽、滚轮转发、轨道区域可起框选。
- 两根分隔条（导航树 / 预览栏）拖宽、双击复位、方向键微调、宽度持久化。
- 图标视图的二维方向键（列数来自 `getComputedStyle(grid).gridTemplateColumns`）。
- 同步从 3 分钟降到约 15 秒。

### 仍然推迟、尚未实现的子功能

- 自由布局视图（free layout）。
- 备份**导入**（只做了导出）。
- HTML5 拖拽过程中的自定义自动滚动（只用浏览器默认行为）。
- 右键菜单中快捷方式的「重命名」为禁用状态。
- 水平滚动条：改自绘竖条后 `scrollbar-width: none` 是全轴的，横条一并没了；
  靠 `.icon-grid` 的 `minmax(min(var(--cell-w), 100%), 1fr)` 保证不会横向溢出，
  详情视图 name 列 `flex:1; min-width:0` 同理。真要横向滚动得再补一条自绘横条。

---

## 5. 自裁定偏差登记（已全部汇报给用户）

早期几轮：滚动条深色 hover 调亮；fable 前景 `#e09468`；去掉「纹理」缩略图档；
角标始终浮动；不做手工虚拟化改用 `content-visibility`；详情视图补全四种状态样式；
图标视图展开的名称改为**向上**生长（与早期「不盖住图标」的说法相反，取舍是宁可
压到图标一点也不要把下一行推开）；缩略图正文从 `**Conversation Overview**` 之后
起算；预览栏支持 Markdown；计时 toast 改为 debug 开关控制；下拉框全部自绘；
排序改自然序（数字段按数值比）。

本轮（#20–#27）：

1. 竖向滚动条改为**自绘浮层**（`src/app/scrollbar.tsx`），原生条关掉；副作用见 §4。
2. 新增 `--danger-solid` / `--danger-solid-hover` 一对 token，与作为前景色的
   `--danger` 分开——深色的 `--danger` 配白字只有 2.93:1，达不到 AA。
   已用 `tokens.test.ts` 锁住 ≥4.5:1。
3. 导航树也做成可拖宽（DESIGN §2.3 只提了预览栏）；预览栏范围严格取规范的
   240–480px，导航树自定为 160–420px。
4. 方向键走到网格边界**停住**，不折行、不环绕。
5. 「已改名」铅笔改为按内容判定（`isRenamed`），提交时把等于远端标题的别名归一化为
   `null`——两处都改是因为历史数据里已经存在「别名 == 远端名」的记录。

本轮（2026-09-19，#28–#36）：

6. `.group-header` 的底色与 1px 细线搬到 `::before` 图层，元素自身不再有
   `border-right`/`background-clip`。副作用是 padding 在吸顶与未吸顶两态下**恒定**，
   标签文字不会再在吸顶瞬间横移。
7. 分隔条的拖拽反馈定为**分隔条所在那条 1px 边框变深**（`--border-strong`），
   不是整条 5px 命中区变色——用户只要「略微变深」，这是最贴近原生的做法。
8. 视图菜单的 Icons / Details 两行从 `disabled` 改为**用圆点标记当前项**。
   原本禁用当前项会让它看起来「不可用」，与「这是选中的」语义相反。
9. `Select` 下拉里的对勾图标也一并换成同一个圆点，保证整个产品只有一套选中词汇。
10. `.details-row` 改为统一 `margin-top: 3px`，删掉 `.details-row + .details-row`。
    原规则跨不过分组容器，导致每组第一行贴着表头 / 上一组，焦点环被切。
11. `unfiledRemaining` 从 i18n **两本字典里都删掉**，而不是只在渲染处隐藏——
    没有任何调用方了，留着就是死键。
12. 导航树补上了它一直没有的 `dragleave`：原先把文件拖进导航树再拖走，
    高亮会永久卡住。属于顺手修的潜在 bug，用户没提。
13. 框选**全程不经过 React**：拖动时直接改 DOM class 与 `input.checked`，
    只在 pointerup 时 `onCommit` 一次。这是「卡顿没有根本性解决」的真正根因——
    每帧两次 `setState` × 1296 个子节点的 reconcile。

本轮（2026-09-19 第二批）：

14. **原生拖拽也全部改为命令式**。`draggingKeys` / `dropFolderId` 两个 state 删除，
    `is-dragging` / `is-drop` 由 App 直接写 `classList`；`ViewProps` 去掉
    `dropKey`/`draggingKeys`，`NavTreeProps` 去掉 `dropFolderId`，`Flags` 只剩
    `selected/cut/focused/editing`。一个无依赖数组的 `useEffect` 在每次渲染后把
    这两个类**重新刷一遍**（自愈），空闲时的代价是一次 `Set.size` 判断。
15. `FolderIcon` 不再接 `dropTarget`，落点描边改由祖先 `.is-drop` 的后代选择器给。
    `.folder-icon.is-drop` 的旧选择器保留，因为 showcase 要孤立地展示这个状态。
16. 新增 token **`--border-active`**（浅 `#bdb4a0` / 深 `#4a4841`）。分隔条原先用
    `--border-strong`，但它在浅色下是 `#141413`，近乎纯黑——用户要的是「微微变深到
    浅褐色」。`--border-strong` 保留给详情视图列头那种需要字重感的分隔线。

本轮（2026-09-19 第三批，对应用户 11 条意见）：

17. 彻底删除的对话**不留墓碑**，下次同步会从服务器回来——确认框里明说了这一点。
    真要做墓碑得存一张"已拒绝的 uuid"表，那是同步语义的改动，不是删除语义的。
18. `purgeRefs` 不再在目标尚未进回收站时抛错，改由 UI 把关（「已删除」视图之外
    根本不提供这个动作）。
19. `compareModel` 由降序翻成**升序**，`SERIES_RANK` 重编号为 `other:0 … fable:4`，
    `sortItems` 里那个 `-compareModel` 的取反随之删掉。原先"升序 = 等级最低在前"
    是靠两次取反凑出来的，读代码的人必然被绕进去。
20. 新增 `naturalAsc(key)`：**切换排序键时重置为该键的自然方向**（名称升序、日期
    降序），和资源管理器一致；只有点同一个键才翻转方向。
21. `navFolders` 拆成 `navRoot` + `navFolders`；根节点**不画文件夹图标**，好和上面的
    快速访问对齐。
22. 「未归档」**同时**出现在快速访问和文件夹树里，且在两处都置顶。它确实是一个真实
    文件夹，也确实是最常去的地方，两个身份都给它。
23. 「定位到原文件」不只给快捷方式：**任何在自己文件夹之外被列出来的对话**都给
    （搜索结果、最近、已标记…）。用户只提了快捷方式，但同一个动作在这些场景下
    意义完全一样。
24. Esc 的优先级定为：**先取消剪切，再清除选择**。两件事都用 Esc，得有先后。
25. `.paper-footer` 右侧预留 `badge + 4` px，避免右下角的快捷方式箭头压住模型标签。
26. 顺手修掉了快速跳转（Ctrl+G）跳转后丢失选中的老 bug，用户没提。
27. **详情列宽按文件夹视图保存**（`FolderView.columnWidths`，稀疏），并以
    CSS 自定义属性 `--col-<key>` 下发；**双击手柄复位该列**——这是用户没要、但几乎
    零成本的一个附赠动作。
28. **`is-selected` 与复选框的勾离开 React 渲染输出**，和 `is-dragging`/`is-drop`
    一样改为命令式绘制；`ItemCheck` 因此变成非受控输入。刷新用的是
    `useLayoutEffect`（被动 effect 不保证在绘制前跑完，会闪一帧），并在拖拽进行中
    跳过（`marquee.isLive()`，否则会把过时的选择集盖到拖拽结果上）。
29. **点空白处清除选择改在 pointerup 通知 React**（视觉上仍是瞬时的命令式擦除）。
    这才是 #10「框选一些之后再立刻框选其他」卡顿的第二个根因。
30. **「回退」不作为新的日志条目记录**（用户原话是要记）。理由写在 DESIGN §8.10：
    把撤销记成动作会无限递归。改为「日志是直线 + 游标标记你站在哪」，用户要的三个
    能力（看全部动作 / 回到某个动作之前 / 取消回退）一个不少，而且退回去再走回来
    能精确复原。唯一动词是 `ops.jumpTo(seq)`。
31. 历史记录面板**自己读自己的数据**，不挂进 `useAppData`——否则每次写入都要顺带读
    最多 200 条事务记录去喂一个绝大多数时间关着的弹窗。
32. 历史跳转**不做二次确认**（跳转可逆），只弹一条**不带撤销按钮**的 toast 报步数。

本轮（2026-09-22，叠放）：

33. **叠放不是文件夹**，是"在对话本来所在的文件夹里把它们视觉上折起来"。
    `Chat.folderId` 不动，成员在读取时解析，解析不到就不画。代价是
    `Stack.members` 里会留下已失效的键——这是刻意的，换来的是移动/删除/同步/撤销
    全都不必知道叠放存在。
34. **单条的那一天在自动叠放下保持散开**，不会变成"一摞一个"。与 `STACK_MIN_MEMBERS`
    一致，但与 macOS 略有出入（macOS 会堆一个）。
35. **展开状态只存在于会话中，且按位置分键**。自动叠放的 id 只在这份列表存在期间
    有意义，持久化只会往库里塞死键。
36. **一摞的"代表卡"是最新的成员**，`item.chat` 指向它。排序/分组/预览栏因此零改动
    工作，代价是真想表达"这一摞"的代码必须先看 `ref.kind`。
37. **新增图标 `layers` / `layersOff`**（Icon.tsx）。
38. **自动叠放开启时，右键菜单的「叠放」变成一句说明并置灰**，而不是禁用一个
    不解释原因的按钮。
39. **一摞被选中时，所有动作（移动/删除/剪切/拖拽/标记）作用于它的成员**——
    `expandRefs` 在 `selectedRefs()` 这一个收口处展开。与 macOS 拖一摞 = 拖里面的
    文件一致。
40. **选中一摞 + 几个散的再叠放 = 合并，不是嵌套**（`stackableKeys`）。
41. ~~预览栏对一摞显示的是代表卡那条对话~~ —— **2026-09-24 按用户要求改掉**：
    选中一摞时显示 `StackPreview`（这一摞的信息）。同一轮还改成了**单击就展开**。
42. **一摞接受拖放，语义是「加入这一摞」而不是「移动进去」**；自动叠放的摞
    连高亮都不给，因为它根本没有记录可以加。
43. `src/app/App.tsx` 里曾混进两个**字面 NUL 字节**（分组折叠键的分隔符直接打成了
    实际的 U+0000），导致 Grep 把它判成二进制文件、Edit 工具匹配失败。已全部改回
    `\u0000` 转义。**以后写分隔符一律用转义。**

本轮（2026-09-24，AI 整理 + 叠放两处修改）：

44. **面板停靠在预览窗格的位置，不用模态框**。整理的意义就是看着文件夹变化。
45. **写入只有一个工具 `apply_changes`，一次调用 = 一批 = 一步撤销**，一批里可以同时建文件夹并移入。
46. **两种接口格式都支持**（Anthropic / OpenAI 兼容），另有认证方式覆盖（部分 Anthropic 格式中转站要 Bearer）。
47. **自动执行默认开**，面板底部和设置里都能关；**删除无论开关都要确认**（红色「确认删除」）。
48. 只选了对话时，**允许新建文件夹**（用户只说了「移动到其他文件夹」）——新增是可撤销的、只加不改。
49. **对话记录不走 data port**：它不是库数据，广播每个回合会让其它标签页白白重读整个索引。库的修改仍走 port。
50. **AI 配置（含 key）存在单独的 meta 键**，不放进 `Settings`，保证它不会随设置导出。
51. 网络权限用 **`optional_host_permissions` 按域名按需申请**，不在安装时要「所有网站」。
52. 工具输出给模型看的是**英文**，界面上的行摘要和预览走 i18n。
53. **旧的读取结果折叠成一行摘要**再发给模型；界面上仍可展开原文。
54. 官方接口打 prompt caching 标记，**中转站不打**（避免不兼容）。
55. 新增图标 `sparkle` / `rewind` / `stop` / `eye`。
56. **双击一摞只切换一次**（连击第二下被忽略），折叠按钮和计数角标也一样——否则单击展开会被双击抵消。
57. 顺手修的：`onSyncProgress` 在非扩展环境下不再崩溃，App 页面第一次能在开发服务器里打开。
58. 顺手修的：`D:\Desktop\.claude\launch.json` 里的 `chatexplorer-showcase` 改指向新目录。

本轮（2026-09-24 第二批，用户同意「整理偏好 / 推断现有习惯 / 偏好跨对话积累」，否决「强制先定方案」）：

59. **整理偏好存在 `AiConfig.preferences`**（和 key 放一起，不进 Settings、不进备份），
    以 `<preferences>` 块放在系统提示词里、排在默认做法之前，明写「压过默认」。
60. **`remember_preference` 无论「自动执行」开关都要确认**——它改的是以后每段对话听到的话。
    不进撤销记录（改配置不改库），回退对话也不会撤掉已记住的偏好；要删就在设置里删。
61. **提示词里的偏好每一轮都现读**，不用循环开始时捕获的配置——对话中途记住的偏好下一轮就生效。
62. **所有右键菜单的标签改为单行 + 省略号**，菜单宽度取内容宽（上限 360px），好让边缘翻转
    把整个菜单挪进视口。历史对话把时间放进右侧的次要位，保证被截掉的是标题而不是时间。
63. 审美约束写进了提示词（回复不用 emoji / 感叹号 / 客套；命名规范）。方法论还在和用户讨论，**尚未写入**。
64. `version` 这个 i18n 键原本就在（「版本号」），之前没人用；这次直接用它，没有新增重复键。
65. **Bash 工具会吃掉 heredoc 里的反斜杠**（`\s` 变 `s`，`\n` 变真换行），本轮在 runner.ts 里踩过一次。
 时用
    `split(a).join(b)`。本轮在 tools.ts 的正则转义里踩过一次。

本轮（2026-09-24 第三批，用户：一次性对话选 a「原地不动」、顶层按领域同意、**不要元分析**；
反馈「编号全是 1.」「要善用加粗」「为什么查了 27 步」）：

66. **默认方法论写进提示词**：摘出有长期价值的归档，一次性对话原地不动；按用途分；顶层按领域、
    下按项目；粒度（3–5 个起建、≤3 层、顶层约 8 个）；拿不准就不动。**没有元分析。**
67. **折叠改为按总量（12 万字）**，不再按「最近 3 轮」。原规则让「先别动手」的规划请求反复重读。
68. **搜索支持 `|` / `OR`，英文与数字按整词匹配，标题命中在前**。真实会话里 `code OR 编程` 得 0、
    `SAT` 命中 1325/1365、`AP` 命中 1066——三个都是纯子串匹配造成的。
69. **只看标题时一页最多 500 条**（带简介开头仍 200），提示词要求按顺序通读、不抽样、不重读，
    并在回复里留一段简短的分组草稿（自己的文字不会被折叠）。
70. **连续查阅在面板里合并成一行**「查阅了 N 次 · 读取 x · 搜索 y」，可展开；单独一次不合并。
71. **Markdown 编号列表保留源编号**（`<ol start>`），修掉模型在编号项间空行导致的「全是 1.」。
72. 提示词里「少用粗体」改为**善用加粗**：只加粗文件夹名、关键数字、需要用户拍板的问题。
73. 面板重绘用 rAF 节流；**标签页在后台时 rAF 暂停，面板不刷新，但 agent 照常运行**，切回来即刷新。
    这是有意的（后台不做无用渲染），记下来免得以后误判成 bug。

---

## 6. 交给用户的杂务（之前已提过，待确认）

- 从 Edge 中移除 `_recon/test-ext` 探测扩展。
- 删除泄漏的 `bz1dkmrg1.txt`。
- `src/app/styles.css` 已成孤儿文件，可删。
- **拖拽卡死的 5 步诊断协议还没有回复**——这是唯一一个我一个人推不动的问题，
  前两次诊断都判错了（用户原话：「拖拽卡死仍然完全没有解决」）。

---

## 7. 关键实现细节备忘

- **选择语义仿 Windows 资源管理器**：mousedown 就选中；多选状态下点击已选项不立刻塌缩，而是记 `pendingCollapse`，在 click 且未发生拖拽时才塌缩为单选。
- **搜索覆盖当前位置但不污染导航历史**：`effLoc` 在 `searchQuery` 非空时替换为 search location，scope 取当前文件夹（虚拟节点下取 ROOT）。
- **虚拟节点的视图状态**不持久化，存在按 `locationKey` 索引的本地 state 里。
- **模型排序**〔2026-09-19 已改，旧注释作废〕：`compareModel` 现在**本身就是升序**，
  `SERIES_RANK` 是 `other:0 / haiku:1 / sonnet:2 / opus:3 / fable:4`，`sortItems`
  里那个 `-compareModel` 的取反**已经删掉**。以前「升序 = 等级最低在前」是靠两次
  取反凑出来的，谁读都得绕一圈。
- **文件夹排序**：无论排序键是什么，文件夹块一律按名称（`"zh-Hans-CN-u-co-pinyin"` 拼音排序）排，因为按日期排会让文件夹呈现为创建顺序、观感随机。
- **撤销日志**：**9** 个原语（`folder.put/del`、`chat.put/patch/del`、`shortcut.put/del`、
  `stack.put/del`），逆操作计算得出，seq 游标，**`MAX_LOG 1000`**（2026-09-24 由 200 提高）。撤销与重做共用同一个动词 `ops.jumpTo(seq)`，
  **回退本身不记进日志**（否则无限递归，见 DESIGN §8.10）。
- **打开会话**：`focusExisting` 模式下先 `chrome.tabs.query({url: url + "*"})` 尝试聚焦已有标签页（整段 try/catch，权限缺失就回落），否则 `window.open(url, "_blank", "noopener")`。

### AI 整理（2026-09-24）

- **一批 = 一步撤销 = 一个回退节点。** `apply_changes` 的 seq 存在 `ToolBlock.seq` 上，
  也追加进 `Session.steps`；后者的并集用来区分「agent 的步」和「用户手动的步」。
- **回退 = `ops.jumpBefore(锚点)` + 截断回合。** 锚点是被截掉部分里最早的 seq。
  前驱要在事务**里面**找（用户可能在两批之间手动操作过，前驱也可能已被挤出日志）。
  锚点已不在日志里 → 返回 null → 界面说「已无法回退」，不猜。
- **权限按原始记录判定，位置按工作副本判定。** 同一批里先移进新文件夹、再改名，
  不能因为「新文件夹不在最初的范围集合里」就拒绝改名。有单测锁住。
- **审批要先登记再通知**：`execute` 必须先设 `pending` 再调 `onChange`，否则界面
  读 `awaiting` 为空、按钮不出现、循环永远等下去。端到端测试抓到过这个 bug。
- **每个工具调用都必须有结果**，包括被中断的——两种 API 都拒绝没有结果的调用。
- **流式渲染按 rAF 节流**；runner 就地修改 turn/block 对象，面板每帧重读一次。
- **审批按钮的判断是 `plan.hasDelete || !autoApply`**；执行前**重新规划一次**，因为等待期间库可能变了。

### 叠放（2026-09-22）

- **一摞不是容器，是一次视觉折叠。** `Chat.folderId` 不动。这是整个功能唯一真正
  重要的判断：反过来做就等于凭空多出第二套归档系统，面包屑、级联删除、快捷方式
  语义全要再实现一遍。
- **成员在读取时解析。** `Stack.members` 存项键（`chat:<uuid>` / `shortcut:<id>`），
  解析不到就不画。于是移动 / 删除 / 同步 / 撤销**全都不必知道叠放存在**。
  唯一例外是 `purgeRefs`：连所在文件夹一起被彻底删除的一摞再也没有入口能手动解散，
  必须在那里顺手扫掉。
- **折叠发生在排序之后、分组之前。** 一摞占据它第一个成员的位置。这是唯一能让
  「摊开后成员紧跟折叠按钮」成立的顺序，也让 `compareBy` 完全不必认识叠放。
- **代表卡**：一摞对外表现为「最新那个成员的对话」（`item.chat`），排序 / 分组 /
  预览栏因此零改动工作。代价：真想表达「这一摞」的代码必须先看 `ref.kind`。
- **`expandRefs` 是唯一收口。** 一摞被选中时，`selectedRefs()` 就地把它展开成成员，
  所以移动 / 删除 / 剪切 / 拖拽 / 标记全部拿到的是真实对话，没有一个动作需要
  special-case 叠放。
- **`dayKey` 必须按本地日**，不能写 `iso.slice(0, 10)`——存的是 UTC，UTC+8 下
  每天 08:00 之后都会落到错误的一侧。
- **展开状态是会话级的**，按 `locationKey` 分键。自动叠放的 id 只在这份列表存在
  期间有意义，持久化只会往库里攒死键。
- **动画自绘**：`stack-fold`（折叠）/ `stack-fan`（成员逐格飞出，`--i` ×
  `--stack-step`，11 格封顶）/ `stack-unfold`（折叠按钮）。
  `prefers-reduced-motion` 在**令牌层**已经统一归零，动画本身不写媒体查询。
- **倾角受 `content-visibility` 约束**：`.grid-cell` 的绘制包含会裁掉探出边框盒的
  部分，所以卡片最多倾 3°（256px 下探出约 7px，padding 有 12px）。
- `.grid-cell.is-stacked` 用**点线边框**而不是底色——底色那条通道属于选中态。
