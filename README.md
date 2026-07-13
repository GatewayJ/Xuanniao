# 玄鸟 Xuanniao

Xuanniao is a local-first Markdown workspace for designing, discussing, and refining documents with Codex through ACP.

玄鸟是一个本地优先的 Markdown 文档协作工具，用于在浏览器中围绕文档与 Codex 讨论、设计和迭代内容。

---

## 中文

### 产品定位

玄鸟的核心不是聊天窗口，而是文档本身。用户在浏览器中打开本地 Markdown 文件，选中文档片段创建 thread，再让 Codex 围绕该片段解释、补充、重写或修改文档。

它适合需要“边写文档、边和 AI 讨论”的场景：

- 技术方案设计
- PRD / RFC / ADR 编写
- 架构说明和 Mermaid 图维护
- 接口设计、边界条件梳理
- 测试用例生成
- 本地 Markdown 知识整理

### 特色

- **玄鸟品牌**：顶栏使用抽象玄鸟矢量 logo，深色底代表夜空，青色与金色翼形代表传信、批注与文档流转。
- **Local-first**：文档、thread、历史记录默认保存在本地。
- **Markdown-native**：CodeMirror 直接编辑 Markdown 源文本，Preview 用 markdown-it 渲染。
- **段落级协作**：选中文本创建 thread，评论与 Codex 回复绑定到文档 anchor。
- **Preview 也能创建 thread**：在预览页选择文本后可以创建 thread 或直接提问。
- **Thread anchor 跟随编辑**：编辑文档时，thread 的 `start/end/lineStart/lineEnd` 会随 CodeMirror change map 更新。
- **Codex 可修改选区**：当用户明确要求改写、翻译、替换或修改时，玄鸟要求 Codex 返回受控 replacement，并由玄鸟写入文档。
- **可配置 Agent 权限**：默认给予 Codex 完全访问权限，也可以用 `XUANNIAO_AGENT_MODE=read-only` 启动只读会话。
- **Mermaid 支持**：Markdown Preview 渲染 Mermaid，并支持横向滚动和全屏放大查看。
- **系统文件选择**：可以从 workspace 外打开 Markdown 文件，也可以手动输入绝对路径。
- **Markdown 回复渲染**：thread 中的消息按 Markdown-compatible plain text 渲染，代码、XML、JSON、diff、日志建议使用 fenced code block。

### 程序架构

```text
┌──────────────────────────── Browser / React ────────────────────────────┐
│ TopBar / DocumentPane / ThreadRail / FilePickerModal / DiagramViewer     │
│ App.tsx: state orchestration, document switching, thread flow            │
│ ThreadEditor.ts: CodeMirror adapter, selection, decorations, anchor map  │
│ markdown.ts: markdown-it preview, message rendering, Mermaid rendering   │
└─────────────────────────────── fetch /api ───────────────────────────────┘
                                      │
┌──────────────────────────── Node HTTP server ────────────────────────────┐
│ server/index.js: REST API, static serving, document switching            │
│ thread-store.js: sidecar thread persistence in .xuanniao/                │
│ block-index.js: lightweight Markdown block index                         │
│ acp-client.js: ACP JSON-RPC client + per-thread session lifecycle        │
└──────────────────────────────── ACP ──────────────────────────────────────┘
                                      │
                         local Markdown file + sidecar JSON
```

### 代码分层

| 层 | 文件 | 说明 |
| --- | --- | --- |
| Web entry | `web/src/main.tsx` | React 入口 |
| App orchestration | `web/src/App.tsx` | 全局状态、文档切换、thread 创建、自动保存、agent 调用结果处理 |
| UI components | `web/src/components/*` | 顶栏、文档面板、评论栏、文件选择、图表全屏查看 |
| Editor adapter | `web/src/ThreadEditor.ts` | CodeMirror 6 初始化、选区读取、thread decoration、anchor remap |
| Preview/rendering | `web/src/markdown.ts` | Markdown preview、message Markdown、Mermaid 渲染 |
| Hooks | `web/src/hooks/*` | Preview 渲染副作用、评论栏宽度拖拽 |
| API client | `web/src/api.ts` | 浏览器侧 REST API 封装 |
| Shared types | `web/src/types.ts` | 文档、thread、message、anchor 类型 |
| Server entry | `server/index.js` | HTTP API、静态文件、文档读写、文件选择 |
| Thread store | `server/lib/thread-store.js` | `.xuanniao/*.threads.json` 持久化 |
| ACP client | `server/lib/acp-client.js` | ACP 进程、thread session、prompt、权限与恢复 |
| Block index | `server/lib/block-index.js` | Markdown 块和 outline 索引 |

> `Cargo.toml` 和 `src/main.rs` 目前只是早期 CLI 壳工程，当前可运行产品路径是 Node + Vite。

### 数据与状态

- 当前打开的 Markdown 文件直接读写原文件。
- Thread 数据保存在同目录下的 sidecar：

```text
.xuanniao/<markdown-file-name>.threads.json
```

- 每个 thread 保存：
  - `selectedText`
  - `anchor.start`
  - `anchor.end`
  - `anchor.lineStart`
  - `anchor.lineEnd`
  - `acpSessionId`
  - 多轮 message 历史

- 编辑文档时，前端用 CodeMirror transaction 的 change map 更新 anchor，并 debounce 写回 sidecar。

### Agent 与 ACP session

当前实现是 **thread-level ACP session**：

- 一个活动文档对应一个 `AcpDocumentAgent`。
- 一个 `AcpDocumentAgent` 只启动一个 `codex-acp` 进程。
- 每个 thread 第一次向 Codex 提问时创建自己的 ACP session。
- `acpSessionId` 保存在 thread sidecar 中；服务重启后通过 `session/load` 恢复。
- 请求通过 `promptLock` 串行化。
- 切换文档时销毁旧 ACP 进程，并为新文档启动新的 ACP 进程。

调用 Codex 前没有使用 ACP 的独立 `system` 字段，而是由 `server/lib/acp-client.js` 的 `buildPrompt()` 拼出完整 prompt。prompt 中包含：

- 玄鸟的协作规则
- Markdown-compatible 回复约定
- 当前文档路径、标题和完整内容
- 选中文本
- anchor
- 当前 thread 的完整消息历史
- 当前用户问题

编辑模式下会额外要求 Codex 只返回：

```text
<XUANNIAO_REPLACEMENT>
replacement markdown here
</XUANNIAO_REPLACEMENT>
```

玄鸟解析该 replacement 后由服务端写入文档。默认的完全访问模式也允许 Codex 直接完成用户要求的仓库级操作。

玄鸟只支持 ACP，不再 fallback 到 `codex exec`。服务启动时会初始化 ACP；找不到或无法启动 `codex-acp` 时立即报错退出。

### 运行方式

要求：

- Node.js >= 20
- npm
- 必需：ACP adapter `codex-acp`
- 必需：Codex CLI `codex`，由 `codex-acp` 作为后端使用

安装依赖：

```bash
npm ci
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
```

推荐开发运行：

```bash
make run
```

默认打开：

```text
http://127.0.0.1:5173
```

默认文档是 `prd.md`。打开其他文档：

```bash
make run FILE=docs/example.md
```

自定义端口：

```bash
make run SERVER_PORT=4174 WEB_PORT=5174
```

手动运行 API server：

```bash
npm start -- prd.md
```

手动运行 Vite web：

```bash
XUANNIAO_API_HOST=127.0.0.1 XUANNIAO_API_PORT=4173 npm run web:dev
```

生产构建：

```bash
npm run web:build
```

检查：

```bash
npm run check
```

### ACP / Codex 配置

Agent 默认拥有完全访问权限，ACP 会自动处理权限请求：

```bash
make run
```

需要只读会话时：

```bash
XUANNIAO_AGENT_MODE=read-only make run
```

默认 ACP 命令：

```text
codex-acp
```

指定 ACP adapter：

```bash
XUANNIAO_ACP_CMD="/path/to/codex-acp" npm start -- prd.md
```

如果 `codex login status` 已经显示登录，但 ACP 仍提示需要认证，可以允许 ACP adapter 使用现有凭据：

```bash
XUANNIAO_ACP_SKIP_AUTH=1 npm start -- prd.md
```

指定供 `codex-acp` 使用的 Codex 可执行文件：

```bash
CODEX_PATH="/path/to/codex" npm start -- prd.md
```

调整超时时间：

```bash
XUANNIAO_ACP_TIMEOUT_MS=300000 npm start -- prd.md
```

### 文件选择

玄鸟会列出 workspace 内的 Markdown 文件，也支持：

- 输入绝对路径打开 workspace 外文件
- 点击 `Browse...` 打开系统文件选择器

Linux 下系统选择器会依次尝试 `zenity`、`kdialog`、`yad`、`qarma`、Python tkinter。macOS 使用 `osascript`，Windows 使用 PowerShell OpenFileDialog。

### 使用流程

1. 打开一个 Markdown 文件。
2. 在 Edit 或 Preview 中选择一段文本。
3. 点击 `New Thread` 创建 thread，或点击 `Ask Codex About Selection` 直接提问。
4. 在右侧评论栏中继续添加本地评论或向 Codex 提问。
5. 如果想让 Codex 改文档，明确使用“修改、改写、翻译、替换、edit、rewrite、replace”等意图。
6. 玄鸟会在可定位选区时应用 replacement，并更新 thread anchor。

### 典型场景

- **技术方案设计**：围绕架构、模块边界、存储模型、安全模型反复讨论。
- **PRD/RFC 打磨**：选择某个需求段落，让 Codex 补充边界条件、异常路径、验收标准。
- **接口设计**：选择 API 描述，让 Codex 生成请求/响应示例、错误码、兼容性说明。
- **测试设计**：针对选中功能生成正常路径、异常路径、并发、权限和恢复测试。
- **图表审阅**：在 Mermaid 架构图旁创建 thread，并用全屏模式查看长链路图。
- **本地文档问答**：不把文档上传到云端，在本机围绕 Markdown 做讨论和迭代。

### 当前限制

- Thread 持久化使用 JSON sidecar，适合 MVP，后续可以迁移到 SQLite。
- 文档修改目前使用选区 replacement，不是完整 patch review flow。
- 完全访问是默认模式；需要禁止修改时使用 `XUANNIAO_AGENT_MODE=read-only`。

---

## English

### Product Positioning

Xuanniao is a document-centered workspace, not a chat-centered app. You open a local Markdown file in the browser, select a document range, create a thread, and collaborate with Codex around that exact piece of text.

It is designed for workflows where writing and AI discussion happen together:

- technical design documents
- PRDs, RFCs, and ADRs
- architecture notes and Mermaid diagrams
- API design and edge-case analysis
- test-case generation
- local Markdown knowledge work

### Highlights

- **Xuanniao brand**: the top bar uses an abstract vector Xuanniao mark; the dark base suggests night sky, while teal and gold wings suggest message-carrying, annotation, and document flow.
- **Local-first**: documents, threads, and history stay on your machine by default.
- **Markdown-native**: CodeMirror edits Markdown source; markdown-it renders Preview.
- **Range-based collaboration**: selected text becomes an anchored thread.
- **Preview thread creation**: create threads from selected text in Preview as well as Edit.
- **Anchor remapping while editing**: thread `start/end/lineStart/lineEnd` move with CodeMirror change maps.
- **Controlled document edits**: when the user explicitly asks for edits, Codex returns a bounded replacement and Xuanniao applies it.
- **Configurable agent access**: Codex has full access by default; start with `XUANNIAO_AGENT_MODE=read-only` for a read-only session.
- **Mermaid support**: diagrams render locally, support horizontal scrolling, and can be opened in a fullscreen zoom viewer.
- **System file picker**: open Markdown files outside the workspace through a native picker or absolute path.
- **Markdown-rendered replies**: thread messages are rendered as Markdown-compatible plain text.

### Architecture

```text
┌──────────────────────────── Browser / React ────────────────────────────┐
│ TopBar / DocumentPane / ThreadRail / FilePickerModal / DiagramViewer     │
│ App.tsx: state orchestration, document switching, thread flow            │
│ ThreadEditor.ts: CodeMirror adapter, selection, decorations, anchor map  │
│ markdown.ts: markdown-it preview, message rendering, Mermaid rendering   │
└─────────────────────────────── fetch /api ───────────────────────────────┘
                                      │
┌──────────────────────────── Node HTTP server ────────────────────────────┐
│ server/index.js: REST API, static serving, document switching            │
│ thread-store.js: sidecar thread persistence in .xuanniao/                │
│ block-index.js: lightweight Markdown block index                         │
│ acp-client.js: ACP JSON-RPC client + per-thread session lifecycle        │
└──────────────────────────────── ACP ──────────────────────────────────────┘
                                      │
                         local Markdown file + sidecar JSON
```

### Code Boundaries

| Layer | Files | Responsibility |
| --- | --- | --- |
| Web entry | `web/src/main.tsx` | React entrypoint |
| App orchestration | `web/src/App.tsx` | Global state, document switching, thread flow, autosave, agent result handling |
| UI components | `web/src/components/*` | Top bar, document pane, comment rail, file picker, diagram viewer |
| Editor adapter | `web/src/ThreadEditor.ts` | CodeMirror setup, selection, thread decorations, anchor remapping |
| Preview/rendering | `web/src/markdown.ts` | Markdown preview, message Markdown, Mermaid rendering |
| Hooks | `web/src/hooks/*` | Preview rendering side effects and resizable rail width |
| API client | `web/src/api.ts` | Browser REST API wrapper |
| Shared types | `web/src/types.ts` | Document, thread, message, and anchor types |
| Server entry | `server/index.js` | HTTP API, static serving, document I/O, native file picker |
| Thread store | `server/lib/thread-store.js` | `.xuanniao/*.threads.json` persistence |
| ACP client | `server/lib/acp-client.js` | ACP process, thread sessions, prompts, permissions, and recovery |
| Block index | `server/lib/block-index.js` | Markdown block and outline indexing |

> `Cargo.toml` and `src/main.rs` are currently an early CLI shell. The working app path today is Node + Vite.

### Data Model

- The active Markdown file is read from and written to disk directly.
- Thread data is stored next to the document:

```text
.xuanniao/<markdown-file-name>.threads.json
```

- Each thread stores selected text, anchor positions, line numbers, `acpSessionId`, and message history.
- During editing, the frontend remaps anchors with CodeMirror transaction changes and saves them back to the sidecar file with debounce.

### Agent and ACP Session Model

Xuanniao uses **thread-level ACP sessions**:

- One active document owns one `AcpDocumentAgent`.
- One `AcpDocumentAgent` owns one `codex-acp` process.
- Each thread creates its own ACP session on its first prompt.
- The sidecar persists `acpSessionId`; after a server restart Xuanniao restores it with `session/load`.
- Prompts are serialized with `promptLock`.
- Switching documents replaces the ACP process for the active document.

Xuanniao does not currently send a separate ACP `system` field. Instead, `server/lib/acp-client.js` builds a full text prompt before each `session/prompt`. That prompt includes:

- Xuanniao collaboration rules
- Markdown-compatible reply instructions
- current document path, title, and complete content
- selected text
- anchor JSON
- complete current-thread message history
- the current user question

In edit mode, Xuanniao asks Codex to return only:

```text
<XUANNIAO_REPLACEMENT>
replacement markdown here
</XUANNIAO_REPLACEMENT>
```

Xuanniao parses and applies that replacement itself. In the default full-access mode, Codex may also perform repository-level operations requested by the user.

Xuanniao requires ACP and never falls back to `codex exec`. Startup initializes the adapter and exits immediately if `codex-acp` is missing or cannot start.

### Running

Requirements:

- Node.js >= 20
- npm
- required: an ACP adapter named `codex-acp`
- required: Codex CLI, used by the adapter as its backend

Install dependencies:

```bash
npm ci
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
```

Recommended development run:

```bash
make run
```

Open:

```text
http://127.0.0.1:5173
```

Open a different document:

```bash
make run FILE=docs/example.md
```

Custom ports:

```bash
make run SERVER_PORT=4174 WEB_PORT=5174
```

Run the API server manually:

```bash
npm start -- prd.md
```

Run Vite manually:

```bash
XUANNIAO_API_HOST=127.0.0.1 XUANNIAO_API_PORT=4173 npm run web:dev
```

Build:

```bash
npm run web:build
```

Check:

```bash
npm run check
```

### ACP / Codex Configuration

The agent has full access by default, with ACP permission requests handled automatically:

```bash
make run
```

Start a read-only session when needed:

```bash
XUANNIAO_AGENT_MODE=read-only make run
```

Default ACP command:

```text
codex-acp
```

Use a specific ACP adapter:

```bash
XUANNIAO_ACP_CMD="/path/to/codex-acp" npm start -- prd.md
```

If `codex login status` already reports a logged-in account but ACP still asks for authentication, allow the adapter to use existing credentials:

```bash
XUANNIAO_ACP_SKIP_AUTH=1 npm start -- prd.md
```

Select the Codex executable used by `codex-acp`:

```bash
CODEX_PATH="/path/to/codex" npm start -- prd.md
```

Adjust timeout:

```bash
XUANNIAO_ACP_TIMEOUT_MS=300000 npm start -- prd.md
```

### File Picker

Xuanniao lists Markdown files inside the workspace and also supports opening external files by:

- entering an absolute Markdown path
- clicking `Browse...` to open the system file picker

On Linux, Xuanniao tries `zenity`, `kdialog`, `yad`, `qarma`, and Python tkinter. On macOS it uses `osascript`; on Windows it uses PowerShell OpenFileDialog.

### Workflow

1. Open a Markdown file.
2. Select text in Edit or Preview.
3. Click `New Thread`, or click `Ask Codex About Selection`.
4. Add local comments or ask Codex from the right rail.
5. To let Codex edit the document, use an explicit edit intent such as rewrite, replace, translate, modify, or edit.
6. Xuanniao applies a bounded replacement when the selection can be located and updates the thread anchor.

### Use Cases

- **Technical design**: discuss architecture, module boundaries, storage models, and security models.
- **PRD/RFC refinement**: add edge cases, failure paths, and acceptance criteria.
- **API design**: generate request/response examples, error codes, and compatibility notes.
- **Testing**: derive happy-path, failure-path, concurrency, permission, and recovery tests.
- **Diagram review**: attach threads to Mermaid diagrams and inspect long diagrams in fullscreen.
- **Local document Q&A**: iterate on Markdown documents without moving them into a cloud workspace.

### Current Limits

- Thread persistence uses JSON sidecars; SQLite is a natural next step.
- Document edits use selected-range replacement, not a full patch review flow yet.
- Full access is the default; use `XUANNIAO_AGENT_MODE=read-only` when mutation must be disabled.
