# 玄鸟 Xuanniao

在本地 Markdown 文档上建立可分支、可追溯的 Codex 讨论树。

Xuanniao is a local-first Markdown workspace for branching, traceable document discussions with Codex.

玄鸟以文档而不是聊天窗口为中心：打开本地 Markdown 文件，围绕具体文本创建讨论，再把问题、回答和后续追问组织成一棵多叉树。它适合 PRD、RFC、ADR、技术方案、接口设计和测试规划等需要持续推演的文档工作。

## 核心体验

- **Local-first**：Markdown 原文件和讨论元数据保存在本地。
- **Markdown-native**：使用 CodeMirror 编辑源文本，以 markdown-it 和 Mermaid 渲染预览。
- **文本锚定**：Thread 绑定文档选区，并随编辑自动更新位置。
- **树形讨论**：每个问题都是节点；叶子继续形成子节点，非叶节点创建独立分支，既有路径不会被重排。
- **局部上下文**：每个节点继承祖先上下文，不会混入无关兄弟分支。
- **选区追问**：可以在节点的问题或回答中划选文字，直接创建带引用的追问。
- **空间化导航**：支持无限画布、平移、缩放、节点焦点、面包屑和树形缩略图。
- **受控文档修改**：Codex 可以返回限定范围的 replacement，由玄鸟应用并同步 Thread anchor。
- **Codex 偏好**：设置页动态读取本机 Codex 模型，并按模型能力选择推理深度。
- **自然语言开发执行**：在原有节点输入框中直接要求实现、修复、重构、测试或构建；Codex 会检查项目、修改文件并验证，无需额外的“开始开发”按钮。
- **执行过程可见**：所属节点输入框上方实时展示计划步骤、Diff 统计和 Subagent；正文完成后移入回复折叠留档，刷新后仍可展开。

## 界面

### 文档工作区

左侧编辑或预览 Markdown，右侧 Thread 与文档位置保持对应。只有从文档选区发起“选中文字提问”才会创建新的根 Thread。

### 讨论树总览

点击 Thread 进入全屏画布。叶子节点提供“子节点”入口；已有子路径的节点只提供“分支”入口。新问题始终直接挂到当前节点，不会重排既有路径。

[![多叉讨论树](docs/images/xuanniao-thread-tree.png)](docs/images/xuanniao-thread-tree.png)

### 文档、节点内容与 Tree 联动

Thread 工作区采用三栏布局：左侧预览锚定文档，中间显示当前节点的问题、回答和输入区，右侧展示完整 Tree。点击 Tree 节点会同步中间内容和高亮状态；两条分隔线都可以拖动调整栏宽。叶子节点输入问题时会显示新节点预览和幽灵节点。

## 交互语义

玄鸟根据当前节点是否已有子路径决定唯一可用操作：

```text
从节点创建分支

    B
   / \
  C   D
```

```text
从叶子节点创建下一步

A → B → C
      ↓
A → B → C → D
```

- 点击节点：在中间 content 栏打开该节点，并在右侧 Tree 中保持高亮。
- 切换 Tree 节点：左侧文档预览自动回到当前 Thread 的原文锚点，并使用与主 Preview 相同的激活高亮；原文移动后按最新正文恢复位置。
- 叶子节点只显示 `＋ 子节点`：在当前叶子下创建下一步问题。
- 已有子路径的节点只显示 `⑂ 分支`：从当前节点创建新的独立分支，不移动既有子树。
- 节点 content 输入区遵循同一规则，不提供创建方式切换或路径插入。
- Tree 连接线只表达父子关系，不提供创建按钮。
- 划选问题或回答中的文字：出现带引用的内联提问框。
- `Esc`：先关闭当前节点 content，再次按下关闭 Thread 工作区。
- 拖动栏间分隔线：调整文档、content 与 Tree 的宽度。
- 拖动背景：平移画布。
- 普通滚轮：移动画布。
- `Command/Ctrl + 滚轮`：缩放画布。
- 方向键：在父节点、第一子节点和相邻兄弟节点之间移动。

## 快速开始

### 要求

- Node.js 20.19.x，或 22.12 及更高版本
- npm
- Codex CLI

安装依赖：

```bash
npm ci
codex login
codex --version
```

启动：

```bash
make run
```

默认打开：

```text
http://127.0.0.1:5173
```

默认文档为 `prd.md`。打开其他 Markdown 文件：

```bash
make run FILE=docs/example.md
```

如果端口已被占用：

```bash
make run SERVER_PORT=4174 WEB_PORT=5174
```

## 使用流程

1. 打开本地 Markdown 文件。
2. 在 Edit 或 Preview 中选择一段文字。
3. 点击“选中文字提问”，在选区旁的提问框中创建根 Thread 并向 Codex 提问。
4. 从评论栏打开 Thread，进入讨论树画布。
5. 点击节点查看问题和回答；叶子节点可继续创建子节点，已有子节点的节点可创建并列分支。
6. 在问题或回答中划选文字，基于精确引用继续追问。
7. 明确使用“修改、改写、翻译、替换”等意图时，Codex 可以更新锚定的文档范围。
8. 在节点输入框中用自然语言要求开发工作时，Codex 会在当前工作区执行；切换到其它节点后，进度卡不会全局悬浮，任务节点仍保留运行标记。

## 架构

```text
┌──────────────────────────── Browser / React ────────────────────────────┐
│ DocumentPane · ThreadRail · Thread Canvas · FilePicker · Diagram Viewer │
│ CodeMirror · markdown-it · Mermaid · anchor remapping                   │
└────────────────────────── REST + Agent Run SSE ──────────────────────────┘
                                      │
┌──────────────────────────── Node HTTP Server ───────────────────────────┐
│ document I/O · append-only thread tree · metadata persistence           │
│ Agent Runtime · approval broker · context policy · replacement apply    │
└────────────────────────── semantic runtime API ──────────────────────────┘
                                      │
              Codex app-server (native)  ·  ACP adapter (compatibility)
```

| 层 | 主要文件 | 职责 |
| --- | --- | --- |
| UI 组合 | `web/src/App.tsx` | 组合文档、讨论、权限和文件浏览能力 |
| 浏览器用例 | `web/src/hooks/useDocumentSession.ts`, `useConversationCommands.ts`, `usePermissionInbox.ts` | 文档保存事务、会话命令和权限收件箱 |
| 文档编辑 | `web/src/ThreadEditor.ts` | CodeMirror、选区、装饰和 anchor remap |
| 树形交互 | `web/src/components/ThreadRail.tsx` | 评论栏、无限画布、节点焦点和内联追问 |
| 选区交互 | `web/src/hooks/useMessageSelection.ts` | 消息选区生命周期、引用捕获与提问浮层 |
| 树布局 | `web/src/thread-tree.ts`, `web/src/thread-canvas.ts` | 会话树构建、导航、路径和空间布局 |
| 渲染 | `web/src/markdown.ts` | Markdown、代码块与按需加载的 Mermaid |
| Agent 过程 | `web/src/agent-run.ts`, `components/AgentRunTimeline.tsx` | 实时步骤归并、耗时和可折叠过程展示 |
| HTTP 适配 | `web/src/api.ts`, `server/index.js` | 请求解析、响应和依赖组合 |
| 会话领域 | `server/lib/conversation-model.js` | 分支放置、树状态迁移和 session 失效规则 |
| 应用服务 | `server/lib/conversation-service.js` | 会话命令、Agent 回合和受控文档修改编排 |
| 运行事件 | `server/lib/agent-run-broker.js` | 有界 Agent 事件缓存、SSE 订阅和终态保留 |
| 文档事务 | `server/lib/document-workspace.js` | revision、原子写、锚点校验和活动文档保护 |
| 持久化 | `server/lib/thread-store.js` | Thread JSON 读写、迁移和并发串行化 |
| Runtime 组合 | `server/lib/agent-runtime.js` | 传输选择、配置归一化和应用边界 |
| JSONL 基础设施 | `server/lib/json-line-rpc-process.js` | 子进程、请求关联、超时和诊断缓冲 |
| 原生 Codex | `server/lib/codex-app-server-runtime.js` | app-server 生命周期、thread/turn、分支、事件和审批 |
| 上下文策略 | `server/lib/agent-context.js` | 文档快照、增量变更、分支历史和受控替换约束 |
| ACP 兼容 | `server/lib/acp-client.js` | ACP session、事件、文件能力和审批适配 |

## 数据与上下文

当前 Markdown 文件直接读写原文件。Thread 数据按文档绝对路径的 SHA-256 保存在：

```text
~/xuanniao/<document-path-sha256>/threads.json
```

每个讨论节点保存：

- 节点 ID 与父节点 ID
- 用户问题和 Codex 回答
- 可选的引用文本与来源消息
- Agent adapter、session ID、最近 turn ID 和文档快照哈希
- 创建时间、错误状态和其它消息元数据

当前实现采用 **conversation-node-level Agent session**：

- 默认使用 Codex `app-server`，但仅在第一次 Agent 请求时按需启动；CLI 不可用不会阻断本地文档编辑。
- 每个新问题都是独立节点；根节点使用 `thread/start`，子节点从父节点最近成功 turn 使用 `thread/fork`。
- Agent session 持久化到 Thread store，服务重启后使用 `thread/resume` 恢复。
- 文档未变化时不重复发送完整正文；小范围变化发送精确 splice，大范围变化重新同步完整快照。
- Agent 上下文超过显式字符预算时会失败并提示，不会静默截断；文档快照使用有界 LRU 缓存。
- 新建或重建分支只注入该路径需要的祖先历史，不包含兄弟分支。
- 编辑、删除问题或回答时，会清除当前节点及受影响后代的陈旧 session，避免 Agent 历史与可见树不一致。
- 浏览器刷新会重新订阅活动任务；服务重启后若任务运行状态已经丢失，页面会明确标记为中断并保留节点重试入口。
- 原生 Runtime 只按同一 session 串行化；不同分支可以并行运行。持久化写入由 Thread store 串行提交。
- Agent 完成时会校验分支 revision，并原子写入回答与 session；运行期间祖先路径变化的旧回答和错误回复都不会覆盖新上下文。
- 每个文档响应携带内容 revision；浏览器保存和受控替换使用 compare-and-swap，拒绝覆盖并发或外部修改。
- 浏览器锚点只作为候选位置，服务端根据保存后的正文重新校验并生成 canonical anchor。
- 活动 Markdown 文档是受保护资源：ACP 文件写直接拒绝；所有 Agent 回合结束后还会校验 revision。无法归因的外部修改会保留原文件并报告冲突，不会用旧快照覆盖用户内容。
- 文档切换会失效旧保存队列；保存请求同时携带文档路径和 revision，服务端拒绝落到其它活动文档。Thread metadata 通过临时文件和原子 rename 落盘。
- 原生和 ACP turn 都使用活动空闲超时：输出、工具事件等活动会自动续期，等待用户审批时暂停计时。原生模式先发送 `turn/interrupt`，ACP 模式失效并重启 adapter，避免超时任务的迟到事件污染下一轮。
- 每轮 Agent 请求使用独立运行 ID。命令、工具、文件、搜索、计划、聚合 Diff 和公开 reasoning summary 通过 SSE 实时显示；原生 app-server 的 Subagent 生命周期及其计划、命令、文件、输出、结果和审批会归属到主任务。最终过程和耗时随 assistant message 持久化，正文出现后自动折叠。

ACP 仍作为兼容传输保留，使用通用执行时间线降级，不提供原生计划、聚合 Diff 和 Subagent 详情；它也不支持原生 thread fork，且同一 adapter 进程内的请求会串行执行。Local-first 表示文档和玄鸟元数据保存在本机；模型与网络行为取决于 Codex CLI 或所选 adapter 的配置。

## 文档修改

当用户明确要求修改文档时，玄鸟要求 Codex 返回：

```text
<XUANNIAO_REPLACEMENT>
replacement markdown here
</XUANNIAO_REPLACEMENT>
```

服务端解析 replacement，校验生成回答时的文档 revision，再协调提交 Markdown、Thread anchor、回答和 session；元数据提交失败时回滚 Markdown。revision 已变化时拒绝覆盖；完整删除锚定范围时，对应 Thread 也会删除。

## 配置

Agent 默认使用 Codex app-server 与完全访问沙箱：

```bash
make run
```

应用顶栏的“设置”可以选择 Codex 模型和推理深度。模型目录来自当前 `codex app-server`，只显示每个模型实际支持的推理选项；保存后从下一轮提问生效，不会中断正在执行的任务。偏好保存在 `~/xuanniao/settings.json`，重启和切换文档后继续使用。

只读模式：

```bash
XUANNIAO_AGENT_MODE=read-only make run
```

指定 Codex app-server 命令、模型或推理强度：

```bash
XUANNIAO_CODEX_CMD="/path/to/codex app-server" \
XUANNIAO_CODEX_MODEL="<model-id>" \
XUANNIAO_CODEX_REASONING_EFFORT="high" \
npm start -- prd.md
```

环境变量是首次启动且尚无设置文件时的默认值；一旦在设置页保存，以本机设置文件为准。选择“跟随 Codex 默认”会显式清除环境变量提供的模型或推理深度覆盖。

切换到 ACP 兼容模式：

```bash
npm install -g @agentclientprotocol/codex-acp
XUANNIAO_AGENT_TRANSPORT=acp \
XUANNIAO_ACP_CMD="/path/to/codex-acp" \
XUANNIAO_ACP_SKIP_AUTH=1 \
npm start -- prd.md
```

调整活动空闲超时（默认 10 分钟）；ACP 兼容模式可以单独覆盖：

```bash
XUANNIAO_AGENT_TIMEOUT_MS=300000 npm start -- prd.md
XUANNIAO_ACP_TIMEOUT_MS=300000 XUANNIAO_AGENT_TRANSPORT=acp npm start -- prd.md
```

调整上下文字符预算和文档快照缓存：

```bash
XUANNIAO_AGENT_CONTEXT_MAX_CHARS=1500000 \
XUANNIAO_AGENT_SNAPSHOT_CACHE_ENTRIES=32 \
npm start -- prd.md
```

服务默认只允许回环地址。确需在可信网络暴露时必须显式确认风险：

```bash
HOST=0.0.0.0 XUANNIAO_UNSAFE_ALLOW_REMOTE=1 npm start -- prd.md
```

远程模式仍定位为可信单用户网络，不等同于具备用户认证的多租户服务。

## 开发

手动启动 API：

```bash
npm start -- prd.md
```

手动启动 Vite：

```bash
XUANNIAO_API_HOST=127.0.0.1 XUANNIAO_API_PORT=4173 npm run web:dev
```

检查：

```bash
npm run check
```

生产构建：

```bash
npm run web:build
```

## 适用场景

- PRD、RFC 和 ADR 的需求澄清与持续推演
- 架构、模块边界、存储和安全模型设计
- API 请求响应、错误码和兼容性讨论
- 正常路径、异常路径、并发、权限和恢复测试规划
- Mermaid 架构图与技术路线审阅
- 本地 Markdown 知识整理和 AI 问答

## 当前限制

- Thread 使用本地 JSON 持久化，适合当前单用户工作流，后续可以迁移到 SQLite。
- 文档修改采用锚定范围 replacement，还不是完整的 patch review 工作流。
- 当前是单用户、单 Server 实例、单活动文档。
- 完全访问是默认模式，但活动 Markdown 文档始终由 Xuanniao 文档事务保护；其它仓库写入能力由 Runtime 沙箱和审批策略控制。
- 当前 Runtime 尚未提供 Codex `request_user_input` 表单、MCP elicitation 和动态 client tool UI；这些能力会在 health capability 中明确报告为 `false`，Agent 仍可退回普通文本提问。

---

## English

Xuanniao is a document-centered, local-first Markdown workspace. Select a range in a local document, ask Codex, and organize follow-up questions as a navigable conversation tree.

Key capabilities:

- local Markdown editing and metadata persistence
- anchored discussions that follow document edits
- multi-way conversation trees
- append-only child and sibling branch creation
- inline follow-ups from selected question or answer text
- native Codex threads with per-node resume/fork semantics
- incremental document context and ancestor-only branch recovery
- user-mediated command, file, and permission approvals
- Markdown, code block, and Mermaid rendering
- controlled selected-range document replacement

Quick start:

```bash
npm ci
codex login
make run
```

Then open `http://127.0.0.1:5173`.
