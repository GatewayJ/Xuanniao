# 玄鸟 Xuanniao

在本地 Markdown 文档上建立可分支、可追溯的 Codex 讨论树。

Xuanniao is a local-first Markdown workspace for branching, traceable document discussions with Codex.

玄鸟以文档而不是聊天窗口为中心：打开本地目录和 Markdown 文件，围绕具体文本创建讨论，再把问题、回答与后续追问组织成一棵多叉树。它适合 PRD、RFC、ADR、技术方案、接口设计和测试规划等需要持续推演的工作。

## 当前界面

### 文档工作区

最左侧是可收起的目录树，用于切换目录和 Markdown 文件；中间是默认打开的预览，也可以切换到编辑或大纲；右侧评论卡片与文档位置同步。编辑和预览切换时会保留文档位置。

[![玄鸟文档工作区](docs/images/xuanniao-workspace.png)](docs/images/xuanniao-workspace.png)

### 讨论树

点击评论卡片进入讨论详情。详情页按 `3:5:2` 展示锚定文档、当前节点内容和讨论树；根节点会默认选中。点击任意节点可切换内容，输入新问题时 Tree 会实时展示预览节点。

[![玄鸟讨论树](docs/images/xuanniao-thread-tree.png)](docs/images/xuanniao-thread-tree.png)

### 设置

Codex 模型、推理深度和权限都使用下拉列表。快捷操作有独立设置项，可以增加、删除或修改操作名称与默认提示词；点击“保存设置”后从下一轮提问生效。

[![玄鸟快捷操作设置](docs/images/xuanniao-settings.png)](docs/images/xuanniao-settings.png)

## 核心能力

- **Local-first**：Markdown 原文件和讨论元数据保存在本机。
- **目录工作区**：打开目录后持续显示文件树，点击目录展开或收起，点击 Markdown 文件直接切换；整栏可以折叠。
- **Markdown-native**：CodeMirror 编辑源文本，markdown-it 渲染预览，Mermaid 图可独立放大查看。
- **默认预览**：首次打开、切换文档或刷新页面时默认使用预览模式；预览与编辑保持滚动位置同步。
- **自然语言新建文档**：描述目标后，Codex 可以检查当前仓库及用户引用的 Issue、PR 或其它资料，生成首版 Markdown。
- **文本锚定**：Thread 绑定文档选区，并随浏览器编辑或 Codex 修改自动更新位置。
- **树形讨论**：每个问题都是独立节点；叶子创建子节点，已有子路径的节点创建并列分支。
- **上下文可见**：提问前查看完整文档背景、关注选区、分支历史及显式引用；同文档及跨文档章节、讨论片段可以预览后加入。
- **引用快照**：发送时核对来源版本，保存实际引用内容；支持定位来源、查看历史快照以及更新未发送的引用。
- **独立讨论**：选择“仅带入所选资料”或“同时附带完整文档背景”，建立自己的讨论树和原生会话，并回链来源讨论。
- **比较与综合**：多选节点，双栏查看与固定参考；确认完整来源后创建独立综合讨论，保留原始目标与分歧。
- **文档提案**：从回答生成只读提案，查看完整 Diff，调整后采纳；正文冲突阻止覆盖，支持安全撤销或反向审核。
- **成果记录**：提案、应用与执行分别留档；删除来源讨论后仍能查看快照，原文锚点失效时保留讨论并重新定位。
- **据此执行与停止**：准备目标、限制、验收条件和参考资料后明确开始；先保存再运行，停止后保留已有变化，结果未知时要求核对。
- **工作视图**：默认、专注、比较、审核及总览切换，保存输入、阅读位置和画布变换。
- **项目成果总览**：按文档、种类、状态和依据变化筛选实际记录；跨文档先只读预览，处理时再切换。
- **可选历史标签**：保留已有的问题、想法、假设、证据、风险、决策或任务标签；标签不代表任务执行或决策生命周期，Tree 只汇总问答与未答数量。
- **选区追问**：在文档、节点问题或回答中划选文字，直接创建带引用的追问。
- **可配置快捷操作**：内置发散、审查、收敛和转任务，也可以在设置中自由增删并修改提示词。
- **直接执行与修改**：在节点中要求实现、修复、重构、测试或改写文档，Codex 可按当前权限检查仓库并修改文件。
- **执行过程可见**：计划、命令、文件变化、Diff、搜索和 Subagent 生命周期通过 SSE 实时展示，完成后随回复折叠留档。
- **原生 Codex 会话**：只支持 Codex app-server，以原生 thread start/resume/fork 保持各讨论分支的语义上下文。

## 快速开始

### 要求

- Node.js 20.19.x，或 22.12 及更高版本
- npm
- 已安装并登录的 Codex CLI

```bash
npm ci
codex login
codex --version
make run
```

浏览器默认打开 `http://127.0.0.1:5173`，初始文档为 `prd.md`。

打开其它 Markdown 文件：

```bash
make run FILE=docs/example.md
```

端口被占用时：

```bash
make run SERVER_PORT=4174 WEB_PORT=5174
```

## 使用流程

1. 点击顶栏文档名称打开目录或 Markdown 文件，也可以点击“新建”用自然语言生成文档。
2. 在预览或编辑中选择一段文字。
3. 点击“选中文字提问”，输入根问题并交给 Codex。
4. 从右侧评论卡片进入讨论树，默认展示根节点内容。
5. 点击 Tree 节点切换上下文；叶子节点继续创建子节点，非叶节点创建新分支。
6. 使用快捷操作填入预设提示词，或直接输入分析、写作、修改与开发要求。
7. Codex 需要额外权限时在页面内批准或拒绝；执行结果、过程和文档变化会保存到对应节点。
8. 在“本轮参考”中添加章节或其他讨论的片段；也可点击消息旁的“引用”，或将消息选区拖入参考栏或后续问题输入框。
9. 需要重新限定上下文时，点击详情右上方“开启独立讨论”，核对资料和目标后开始。后续仍可沿新讨论继续追问。
10. 从回答工具栏或选区浮层选择“采纳到文档”“引用到其他讨论”或“据此执行”。准备面板不会自动提交；审核提案后才写入 Markdown，执行则按当前权限直接操作文件。
11. 选择多个节点进入比较，确认来源后开启独立的综合讨论；固定参考仅影响显示。
12. 通过左下角“成果记录”和“项目总览”回看提案、应用与执行。引用依据变化时可对比版本，选择保留或用新版发起讨论。

主要交互：

- `Esc`：先关闭当前浮层，再退出多选或特殊视图，最后退出讨论详情。
- 拖动讨论详情的两条分隔线：调整文档、节点内容和 Tree 的宽度。
- 拖动 Tree 背景：平移画布。
- 普通滚轮：移动画布。
- `Command/Ctrl + 滚轮`：缩放画布。
- 方向键：在父节点、第一子节点和相邻兄弟节点之间移动。

## 架构

```text
┌──────────────────────────── Browser / React ────────────────────────────┐
│ WorkspaceTree · DocumentPane · ThreadRail · Settings · DiagramViewer   │
│ CodeMirror · markdown-it · Mermaid · anchor remapping                  │
└────────────────────────── REST + Agent Run SSE ─────────────────────────┘
                                      │
┌──────────────────────────── Node HTTP Server ───────────────────────────┐
│ document I/O · conversation domain · metadata persistence              │
│ document transactions · permission broker · context policy             │
└──────────────────────────── JSON-RPC / JSONL ────────────────────────────┘
                                      │
                         Codex app-server (native)
```

| 层 | 主要文件 | 职责 |
| --- | --- | --- |
| UI 组合 | `web/src/App.tsx` | 组合目录、文档、讨论、设置、权限和新建文档流程 |
| 文档视图 | `web/src/components/WorkspaceTree.tsx`, `DocumentPane.tsx` | 目录导航以及预览、编辑、大纲切换 |
| 文档编辑 | `web/src/ThreadEditor.ts` | CodeMirror、选区、装饰、滚动和 anchor remap |
| 讨论交互 | `web/src/components/ThreadRail.tsx` | 评论卡片、三栏详情、无限画布、节点内容和快捷操作 |
| 引用交互 | `web/src/components/ReferenceComposer.tsx`, `IndependentDiscussion.tsx` | 资料选择、版本预览、独立讨论准备；不拼接 Agent 提示词 |
| 引用来源 | `web/src/discussion-references.ts`, `server/lib/discussion-context.js` | 前端选区映射与版本对照；服务端验证来源、范围、预算并生成快照 |
| 成果交互 | `OutcomeWorkspace.tsx`, `OutcomePreparation.tsx`, `OutcomeReview.tsx`, `ProjectOverview.tsx` | 来源操作、准备、Diff 审核、结果与项目预览 |
| 树布局 | `web/src/thread-tree.ts`, `thread-canvas.ts` | 会话树构建、导航、分支规则和空间布局 |
| Markdown | `web/src/markdown.ts` | Markdown、代码块和按需加载的 Mermaid |
| 前端用例 | `web/src/hooks/` | 文档保存、会话命令、设置、权限与选区生命周期 |
| HTTP 入口 | `server/index.js` | REST/SSE 适配、活动文档切换和依赖组合 |
| 会话领域 | `server/lib/conversation-model.js`, `conversation-service.js` | 节点状态迁移、分支一致性和 Agent 回合编排 |
| 文档事务 | `server/lib/document-workspace.js` | revision、原子写入、快照对比和锚点重映射 |
| 成果服务 | `activity-gate.js`, `outcome-store.js`, `proposal-service.js`, `workspace-outcomes.js` | 操作排他、成果留档、版本回写、执行与恢复 |
| 项目关联 | `project-workspace.js` | 文档登记、只读预览、来源解析和版本检查 |
| 持久化 | `server/lib/thread-store.js` | Thread JSON 读写、锁和 mutation 串行化 |
| Agent 运行时 | `server/lib/codex-app-server-runtime.js` | app-server 生命周期、thread/turn、事件、超时和审批 |
| 上下文策略 | `server/lib/agent-context.js` | 文档快照、增量变化、选区、问题和引用来源说明 |
| 运行事件 | `server/lib/agent-run-broker.js` | 有界事件缓存、SSE 订阅和完成态保留 |

## 数据与会话

Markdown 直接读写用户选择的原文件。讨论数据按文档绝对路径的 SHA-256 保存到：

```text
~/xuanniao/<document-path-sha256>/threads.json
~/xuanniao/<document-path-sha256>/outcomes.json
```

成果独立于问答保存；删除讨论不删除成果，也不撤销 Markdown 修改。项目索引按项目目录隔离。可设置 `XUANNIAO_DATA_DIR` 覆盖默认数据目录。

全局设置保存到：

```text
~/xuanniao/settings.json
```

每个讨论节点保存父节点、问题、回答、引用、节点类型、Codex thread/turn checkpoint、文档快照哈希和执行过程。当前会话策略是：

- 根节点使用 `thread/start`。
- 独立讨论创建新的 Thread，即使原文选区相同，也不复用来源会话。
- 线性子节点恢复父分支并继续执行。
- 从历史节点创建分支时使用 `thread/fork` 复制精确 turn。
- 服务重启后使用 `thread/resume` 恢复。
- 无法沿用原生会话时，用已保存的问答和引用重建；执行中和结果中均显示重建提示，工具状态不视为完整恢复。
- 修改或删除历史消息时失效受影响的 checkpoint，避免可见树与 Codex 历史不一致。
- Agent 完成时校验分支 revision；运行期间上下文发生变化时，旧结果不会覆盖新状态。

## 上下文与文件修改

普通讨论新 session 首轮会发送完整 Markdown；后续在原生会话历史上补充当前问题、选区、显式引用和必要的文档变化。小范围变化使用精确 splice，大范围变化或缺少快照时重新同步完整文档。独立讨论选择“仅带入所选资料”时不主动附带文档正文或原文锚点正文，也不继承来源分支历史。这个范围限制不改变 Agent 的文件访问权限。

引用在服务端从真实来源重新读取并校验版本，客户端传入的正文不能替代来源。每轮最多 24 项、总计 160,000 字符；超过引用或运行时上下文预算会明确报错，不会静默截断。已发送快照保持不变，更新为新版只影响未发送草稿。移除当前引用不会清除既有会话历史。

文档与讨论是基础上下文。当用户要求检查实现、修复代码，或提供本地仓库、Issue、PR 等引用时，Codex 可以在权限允许的范围内继续读取相关代码和远程资料。

普通回合允许 Codex 直接修改活动 Markdown 或仓库文件。玄鸟在回合前后比较文档快照，通过 `DocumentWorkspace` 协调内容 revision、原子保存和所有 Thread anchor；发现无法归因的并发写入时保留磁盘内容并返回冲突。

“采纳到文档”使用独立原生只读回合，只返回提案；审核后通过版本比较写入。运行、等待权限、停止收尾或未知结果尚未核对时，活动文档切换会被拒绝，仍可预览其他文档。实现与验收边界见[讨论工作区实施记录](docs/discussion-workspace-implementation.md)。

## 设置与环境变量

设置页提供：

- 模型：从 Codex `model/list` 动态读取。
- 推理深度：根据所选模型的能力展示。
- 权限：请求批准、替我审批、完全访问权限或使用 `config.toml`。
- 快捷操作：自定义按钮名称和默认提示词，支持增加与删除。

修改只保存在表单草稿中，点击“保存设置”后才会写入本机设置文件，并从下一轮提问生效；不会中断正在执行的任务。

也可以通过环境变量提供首次启动默认值：

```bash
XUANNIAO_CODEX_CMD="/path/to/codex app-server" \
XUANNIAO_CODEX_MODEL="<model-id>" \
XUANNIAO_CODEX_REASONING_EFFORT="high" \
XUANNIAO_AGENT_PERMISSION_MODE="auto-review" \
npm start -- prd.md
```

其它运行参数：

```bash
XUANNIAO_AGENT_TIMEOUT_MS=300000 \
XUANNIAO_AGENT_CONTEXT_MAX_CHARS=1500000 \
XUANNIAO_AGENT_SNAPSHOT_CACHE_ENTRIES=32 \
npm start -- prd.md
```

服务默认只监听回环地址。确需在可信网络暴露时必须显式确认风险：

```bash
HOST=0.0.0.0 XUANNIAO_UNSAFE_ALLOW_REMOTE=1 npm start -- prd.md
```

该模式不包含用户认证，不能作为多租户服务公开部署。

## 开发

手动启动 API 和 Vite：

```bash
npm start -- prd.md
XUANNIAO_API_HOST=127.0.0.1 XUANNIAO_API_PORT=4173 npm run web:dev
```

完整检查：

```bash
npm run check
```

该命令依次执行服务端语法检查、TypeScript 检查、格式检查、单元测试和 Vite 生产构建。

## 当前限制

- 当前是单用户、单 Server 实例、单活动文档。
- Thread 使用本地 JSON 整文件持久化，适合当前个人工作流。
- Codex 直接修改文档后会自动协调锚点，但还没有修改前的 Diff 确认和跨回合 undo。
- 没有文件 watcher；外部修改在下一次保存或 Agent 回合结束时发现。
- 尚未为 Codex `request_user_input`、MCP elicitation 和动态 client tool 提供专用 UI。
- Local-first 只描述文档与玄鸟元数据的存储位置；模型执行和网络访问仍取决于 Codex 配置与用户授权。

---

## English

Xuanniao is a document-centered, local-first Markdown workspace. Open a directory, select text in a Markdown document, ask Codex, and organize follow-up questions as a navigable conversation tree.

It provides a collapsible file tree, preview/edit/outline views, anchored discussions, multi-way branches, configurable node quick actions, native Codex app-server sessions, permission controls, live run timelines, direct document edits, and automatic anchor reconciliation.

```bash
npm ci
codex login
make run
```

Then open `http://127.0.0.1:5173`.
