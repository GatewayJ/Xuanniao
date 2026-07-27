# 玄鸟 Xuanniao

在本地 Markdown 文档上建立可分支、可追溯的 Codex 讨论树。

Xuanniao is a local-first Markdown workspace for branching, traceable document discussions with Codex through ACP.

玄鸟以文档而不是聊天窗口为中心：打开本地 Markdown 文件，围绕具体文本创建讨论，再把问题、回答和后续追问组织成一棵多叉树。它适合 PRD、RFC、ADR、技术方案、接口设计和测试规划等需要持续推演的文档工作。

## 核心体验

- **Local-first**：Markdown 原文件和讨论元数据保存在本地。
- **Markdown-native**：使用 CodeMirror 编辑源文本，以 markdown-it 和 Mermaid 渲染预览。
- **文本锚定**：Thread 绑定文档选区，并随编辑自动更新位置。
- **树形讨论**：每个问题都是节点，可以继续分支，也可以在既有路径中插入追问。
- **局部上下文**：每个节点继承祖先上下文，不会混入无关兄弟分支。
- **选区追问**：可以在节点的问题或回答中划选文字，直接创建带引用的追问。
- **空间化导航**：支持无限画布、平移、缩放、节点焦点、面包屑和树形缩略图。
- **受控文档修改**：Codex 可以返回限定范围的 replacement，由玄鸟应用并同步 Thread anchor。

## 界面

### 文档工作区

左侧编辑或预览 Markdown，右侧 Thread 与文档位置保持对应。只有从文档选区发起“选中文字提问”才会创建新的根 Thread。

### 讨论树总览

点击 Thread 进入全屏画布。节点底部的 `＋ 分支` 创建新的子分支，连线上的 `＋` 在指定路径中插入节点。

[![多叉讨论树](docs/images/xuanniao-thread-tree.png)](docs/images/xuanniao-thread-tree.png)

### 节点焦点与路径预览

点击节点后，节点在同一画布中进入焦点模式。输入问题时会同时显示路线预览和幽灵节点；可以选择新建分支，或插入某条既有路径。

[![节点焦点、缩略图与路径插入预览](docs/images/xuanniao-node-focus.png)](docs/images/xuanniao-node-focus.png)

## 交互语义

玄鸟明确区分节点操作和路径操作：

```text
从节点创建分支

    B
   / \
  C   D
```

```text
在路径中插入追问

A → B → C
      ↓
A → B → D → C
```

- 点击节点：进入该节点的阅读与追问焦点。
- 点击节点底部 `＋ 分支`：创建新的子分支，不移动既有子节点。
- 点击连线 `＋`：在父子节点之间插入新节点。
- 节点没有子节点时直接创建子节点；只有一个子节点时默认继续当前路径；存在多个子节点时必须选择插入路径或另建分支。
- 划选问题或回答中的文字：出现带引用的内联提问框。
- `Esc`：从节点焦点返回树总览，再次按下关闭 Thread 工作区。
- 拖动背景：平移画布。
- 普通滚轮：移动画布。
- `Command/Ctrl + 滚轮`：缩放画布。
- 方向键：在父节点、第一子节点和相邻兄弟节点之间移动。

## 快速开始

### 要求

- Node.js 20 或更高版本
- npm
- Codex CLI
- ACP adapter：`codex-acp`

安装依赖：

```bash
npm ci
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
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
5. 点击节点查看问题和回答，或在节点与连线上创建新的讨论路径。
6. 在问题或回答中划选文字，基于精确引用继续追问。
7. 明确使用“修改、改写、翻译、替换”等意图时，Codex 可以更新锚定的文档范围。

## 架构

```text
┌──────────────────────────── Browser / React ────────────────────────────┐
│ DocumentPane · ThreadRail · Thread Canvas · FilePicker · Diagram Viewer │
│ CodeMirror · markdown-it · Mermaid · anchor remapping                   │
└─────────────────────────────── fetch /api ───────────────────────────────┘
                                      │
┌──────────────────────────── Node HTTP Server ───────────────────────────┐
│ document I/O · thread tree · path insertion · metadata persistence      │
│ ACP lifecycle · permissions · prompt construction · replacement apply   │
└────────────────────────────────── ACP ───────────────────────────────────┘
                                      │
                         codex-acp → Codex CLI
```

| 层 | 主要文件 | 职责 |
| --- | --- | --- |
| 应用编排 | `web/src/App.tsx` | 文档、Thread、保存、Agent 调用与全局状态 |
| 文档编辑 | `web/src/ThreadEditor.ts` | CodeMirror、选区、装饰和 anchor remap |
| 树形交互 | `web/src/components/ThreadRail.tsx` | 评论栏、无限画布、节点焦点和内联追问 |
| 树布局 | `web/src/thread-tree.ts`, `web/src/thread-canvas.ts` | 会话树构建、导航、路径和空间布局 |
| 渲染 | `web/src/markdown.ts` | Markdown、代码块与 Mermaid |
| API | `web/src/api.ts`, `server/index.js` | 浏览器与本地服务通信 |
| 持久化 | `server/lib/thread-store.js` | Thread、节点关系、消息和 session |
| ACP | `server/lib/acp-client.js` | adapter、节点 session、prompt、权限与恢复 |

> `Cargo.toml` 和 `src/main.rs` 是早期 CLI 壳工程。当前可运行产品使用 Node.js、React 和 Vite。

## 数据与上下文

当前 Markdown 文件直接读写原文件。Thread 数据按文档绝对路径的 SHA-256 保存在：

```text
~/xuanniao/<document-path-sha256>/threads.json
```

每个讨论节点保存：

- 节点 ID 与父节点 ID
- 用户问题和 Codex 回答
- 可选的引用文本与来源消息
- ACP session ID
- 创建时间、错误状态和其它消息元数据

当前实现采用 **conversation-node-level ACP session**：

- 一个活动文档对应一个 `AcpDocumentAgent` 和一个 `codex-acp` 进程。
- 每个讨论节点拥有独立的 ACP session。
- 同一节点内的连续轮次复用该节点 session。
- 新节点的 prompt 由根节点到当前节点的祖先消息构成，不包含兄弟分支。
- session ID 持久化到 Thread store，服务重启后使用 `session/load` 恢复。
- 切换文档时销毁旧 ACP 进程，并为新文档启动新的进程。

Local-first 表示文档和玄鸟元数据保存在本机；Codex 是否使用远端模型或访问网络，取决于 Codex CLI 与 ACP adapter 的配置。

## 文档修改

当用户明确要求修改文档时，玄鸟要求 Codex 返回：

```text
<XUANNIAO_REPLACEMENT>
replacement markdown here
</XUANNIAO_REPLACEMENT>
```

服务端解析 replacement、更新原 Markdown 文件，并重新同步所有受影响的 Thread anchor。完整删除锚定范围时，对应 Thread 也会删除。

## 配置

Agent 默认使用完全访问模式：

```bash
make run
```

只读模式：

```bash
XUANNIAO_AGENT_MODE=read-only make run
```

指定 ACP adapter：

```bash
XUANNIAO_ACP_CMD="/path/to/codex-acp" npm start -- prd.md
```

复用已有 Codex 登录凭据：

```bash
XUANNIAO_ACP_SKIP_AUTH=1 npm start -- prd.md
```

指定 Codex 可执行文件：

```bash
CODEX_PATH="/path/to/codex" npm start -- prd.md
```

调整 ACP 超时：

```bash
XUANNIAO_ACP_TIMEOUT_MS=300000 npm start -- prd.md
```

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
- 完全访问是默认模式；不允许修改时应显式使用只读模式。

---

## English

Xuanniao is a document-centered, local-first Markdown workspace. Select a range in a local document, ask Codex, and organize follow-up questions as a navigable conversation tree.

Key capabilities:

- local Markdown editing and metadata persistence
- anchored discussions that follow document edits
- multi-way conversation trees
- branch creation and targeted path insertion
- inline follow-ups from selected question or answer text
- per-node ACP sessions with ancestor-only context
- Markdown, code block, and Mermaid rendering
- controlled selected-range document replacement

Quick start:

```bash
npm ci
npm install -g @agentclientprotocol/codex-acp
make run
```

Then open `http://127.0.0.1:5173`.
