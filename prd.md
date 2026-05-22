# 玄鸟 — 基于 Codex ACP 的 AI 文档协作工具

## 1. 製品概要

玄鸟是一个本地优先（Local-first）的 AI 文档协作工具。

其目标是：

> 让用户能够在浏览器中直接围绕 Markdown 文档与 Codex 进行协作式设计、讨论与文档完善。

玄鸟不强调多人协作、云同步或复杂权限。

Its core positioning is: 

* AI-native Markdown workspace
* Documented interaction UI for Codex
* Lightweight technical solution design tool
* Document-centric AI workflow

其核心体验：

```bash
codex xuanniao design.md
```

执行后：

* 自动启动本地 Web Server
* 自动打开浏览器
* 展示 Markdown 文档
* 用户可以：

  * 编辑 Markdown
  * 选中段落
  * 向 Codex 提问
  * 与 Codex 多轮讨论
  * 让 Codex 补充文档
  * 让 Codex 生成 Patch
  * Apply Patch 更新文档

整个过程都在浏览器中完成。

---

# 2. 产品目标

## 2.1 核心目标

玄鸟的核心目标：

### 目标一：文档中心化

不是 Chat 中心。

文档才是核心。

AI 只是围绕文档工作。

---

### 目标二：段落级 AI 协作

用户可以：

* 选中一段文本
* 提问
* 多轮追问
* 请求补充
* 请求解释
* 请求重写
* 请求生成 Patch

---

### 目标三：本地优先

所有内容默认本地。

不依赖云。

支持：

* 本地 Markdown 文件
* 本地 Codex
* 本地 Git
* 本地历史记录

---

### 目标四：轻量化

不要：

* Notion 那种重型平台
* Electron 巨型 IDE
* 多人实时 OT
* 云同步
* SaaS 架构

而是：

```text
Markdown + Browser + ACP + Local Server
```

---

# 2.2 MVP 修正版技术判断

当前 MVP 的关键风险不是 UI 框架，而是：

* Markdown 源文本必须稳定
* 选区和评论必须能重新定位
* ACP session 必须可控
* Codex 文件读写权限必须收敛
* Patch 必须可验证后再写入

因此 MVP 不应该一开始进入富文本编辑器和复杂 AST 写回。

## MVP 技术路线

| 层 | MVP 目标选型 | 说明 |
| -- | -- | -- |
| Browser UI | React + Vite | 后续正式前端栈 |
| Editor | CodeMirror 6 | 保持 Markdown 源文本、选区、行列信息稳定；用 Decoration 标记 thread 范围 |
| Preview Renderer | markdown-it | token renderer 可插入 thread marker，适合 Preview 与评论侧栏联动 |
| Diagram Renderer | Mermaid | 渲染 ```mermaid 代码块 |
| Markdown Index | unified/remark 或 markdown-it token map | 用于 block index、heading context、preview，不作为唯一写入源 |
| Server | TypeScript/Node | 与前端和 remark 生态一致，最快验证 ACP 和本地文件工作流 |
| ACP | stdio JSON-RPC client | server 启动 `codex-acp` 子进程 |
| Thread Store | sidecar JSON，后续 SQLite | MVP 先简单持久化评论线程 |
| Patch | Phase 2 | 先使用对话和评论，后续做 diff preview + apply |

## 当前 bootstrap 实现

第一版实现允许先不引入构建链：

```text
Node local server + browser-native UI
```

原因：

* 先验证本地文件、线程、ACP prompt 管线
* 避免 MVP 初期被前端依赖和构建链阻塞
* API 边界保持稳定，后续可替换为 React + CodeMirror

bootstrap 阶段可以使用原生 textarea 作为临时编辑器；正式 MVP 应升级为 CodeMirror 6。

## 为什么必须升级编辑器

原生 textarea 不能对局部文本渲染黄色波浪下划线、评论气泡、range decoration，也无法稳定维护复杂编辑后的 range mapping。

因此：

* Edit 页 thread 标记使用 CodeMirror 6 Decoration
* Preview 页 thread 标记使用 markdown-it token renderer
* Mermaid 使用 mermaid npm 包本地打包
* thread anchor 继续保存 start/end/lineStart/lineEnd，后续增加 range remapping

---

# 3. 用户使用场景

---

## 场景一：技术方案设计

用户：

```text
设计一个对象存储系统
```

Codex：

生成：

* 需求
* 用户故事
* 架构设计
* 元数据设计
* HA
* IAM
* 测试方案

用户：

选中：

```md
需要支持多租户 IAM 隔离
```
提问：

```text
IAM 隔离具体应该怎么设计？
```

Codex：

回复：

```text
建议拆分为：
1. AccessKey 隔离
2. Bucket Policy 隔离
3. STS Session Policy
4. Tenant Namespace

补充：可以在评论中直接让 agent 修改文档，agent 会根据评论定位对应段落并生成精确替换，减少手动同步成本。
```

用户继续追问：

```text
STS Session Policy 是必须的吗？
```

---

## 场景二：PRD 设计

用户：

选中：

```md
用户可以创建 Bucket
```

提问：

```text
这里缺少哪些边界条件？
```

Codex：

补充：

* Bucket 名称冲突
* Region 限制
* 配额限制
* ACL 默认值

---

## 场景三：测试用例生成

用户：

```text
为这个接口生成测试用例
```

Codex：

生成：

* 正常路径
* 异常路径
* 并发测试
* 权限测试
* 超时恢复测试

---

# 4. 产品功能设计

---

# 4.1 Markdown 文档编辑器

## 功能

支持：

* Markdown 编辑
* Markdown 渲染
* 实时预览
* 文档保存
* 自动保存
* 文件切换

---

## 技术选型

推荐：

| 技术             | 用途           |
| -------------- | ------------ |
| React          | UI           |
| CodeMirror 6   | Markdown 源码编辑 |
| markdown-it    | Markdown Preview 渲染 |
| Mermaid        | Mermaid 图渲染 |
| unified/remark | 可选 Markdown block index / AST |

不推荐：

* textarea 作为正式 MVP 编辑器
* contenteditable 原生
* TipTap 作为 Markdown 源码优先编辑器
* 重型 IDE editor

---

# 4.2 段落选择与 AI 提问

## 用户交互

用户：

* 鼠标选中段落
* 出现浮动菜单

例如：

```text
[Ask Codex]
[Explain]
[Expand]
[Rewrite]
[Generate Patch]
```

---

## 关键设计

不是发送纯文本。

而是发送：

```ts
{
  blockId,
  selectedText,
  sectionTitle,
  documentPath,
  threadId
}
```

---

# 4.3 AI Thread 面板

这是核心功能。

---

## 功能

右侧展示：

```text
┌────────────────────┐
│ Thread             │
├────────────────────┤
│ User: IAM 是什么？ │
│                    │
│ Codex: ...         │
│                    │
│ User: STS 呢？     │
│                    │
│ Codex: ...         │
└────────────────────┘
```

支持：

* 多轮对话
* 自动滚动
* markdown 渲染
* code block
* Mermaid
* Apply Patch

---

# 4.4 Patch Apply

这是 AI 文档系统最关键的能力。

---

## 工作流

用户：

```text
请补充这一段
```

Codex：

返回：

```diff
- 当前内容
+ 修改后的内容
```

前端：

* 高亮 diff
* 用户确认
* 应用 patch
* 更新 markdown AST
* 保存文件

---

# 4.5 文档版本管理

## MVP 阶段

使用：

* Git
* 或 SQLite snapshot

即可。

---

## 功能

支持：

* Undo
* Redo
* 历史查看
* Patch 回滚

---

# 5. 系统架构设计

---

# 5.1 总体架构

```text
┌────────────────────────────┐
│         Browser UI          │
│                             │
│ Markdown Editor             │
│ AI Thread Panel             │
└────────────┬───────────────┘
             │ REST / WS
             ▼
┌────────────────────────────┐
│       玄鸟 Server         │
│                             │
│ Context Manager             │
│ Thread Manager              │
│ Patch Manager               │
│ Markdown AST                │
└────────────┬───────────────┘
             │ ACP
             ▼
┌────────────────────────────┐
│         Codex ACP           │
└────────────────────────────┘
```

---

# 5.2 模块划分

---

## Frontend

负责：

* 文档展示
* 编辑器
* Thread UI
* Diff UI
* Patch Apply
* WebSocket

---

## 玄鸟 Server

负责：

* ACP client
* Thread context
* markdown AST
* patch apply
* persistence
* websocket broadcast

---

## Codex ACP

负责：

* reasoning
* tool calling
* file reading
* patch generation
* structured answer

---

# 6. ACP 协议设计

---

# 6.1 ACP Session 生命周期

```text
initialize
  ↓
session/new
  ↓
session/prompt
  ↓
session/update
  ↓
session/prompt(result)
```

---

# 6.2 ACP Session 管理

每个 Markdown 文件：

对应一个 ACP Session。

例如：

```text
/home/jhw/design.md
  -> sess_abc123
```

---

## Session 数据结构

```ts
ACPDocumentSession {
  documentPath: string
  sessionId: string
  createdAt: Date
  lastUsedAt: Date
}
```

---

# 6.3 Thread 与 ACP 的关系

不要：

```text
一个 thread 一个 ACP session
```

正确方式：

```text
一个文档一个 ACP session
多个 thread 共享 session
```

原因：

ACP session 维护：

* AI memory
* reasoning context
* file cache
* tool state

---

# 7. 数据结构设计

---

# 7.1 Document

```ts
Document {
  id: string
  path: string
  title: string
  blocks: Block[]
  updatedAt: Date
}
```

---

# 7.2 Block

```ts
Block {
  id: string
  type: 'paragraph' | 'heading' | 'list' | 'code'
  content: string
  lineStart: number
  lineEnd: number
}
```

---

# 7.3 Thread

```ts
Thread {
  id: string
  blockId: string
  selectedText: string
  messages: Message[]
  createdAt: Date
}
```

---

# 7.4 Message

```ts
Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}
```

---

# 7.5 Patch

```ts
Patch {
  id: string
  threadId: string
  blockId: string
  diff: string
  applied: boolean
}
```

---

# 8. Frontend 详细设计

---

# 8.1 页面布局

```text
┌────────────────────────────────────┐
│ Toolbar                            │
├────────────────────────────────────┤
│ Markdown Editor │ AI Thread Panel  │
│                 │                  │
│                 │                  │
│                 │                  │
└────────────────────────────────────┘
```

---

# 8.2 编辑器能力

支持：

* syntax highlight
* code block
* Mermaid
* markdown preview
* selection tracking
* block id mapping

---

# 8.3 Selection Context

用户选中：

```md
需要支持 IAM 隔离
```

前端生成：

```ts
{
  blockId: 'block-15',
  selectedText: 'IAM 隔离',
  sectionTitle: '多租户设计'
}
```

发送到 server。

---

# 8.4 WebSocket 设计

浏览器连接：

```text
/ws
```

消息：

```json
{
  "type": "thread_message",
  "threadId": "thread-1",
  "message": {}
}
```

---

# 9. Server 详细设计

---

# 9.1 Context Manager

负责：

* 文档上下文
* section context
* thread history
* ACP session mapping

---

## Prompt 构建

```text
当前用户正在编辑 Markdown 文档。

文档路径：...
章节：多租户设计

用户选中的内容：
...

Thread 历史：
...

用户问题：
...
```

---

# 9.2 ACP Client

Server 内部实现 ACP client。

负责：

* initialize
* session/new
* session/prompt
* session/update
* permission handling

---

# 9.3 Patch Manager

负责：

* parse diff
* validate diff
* apply diff
* update AST
* save markdown

---

# 9.4 Markdown AST

不要直接：

```ts
string markdown
```

而是：

```text
Markdown AST
```

推荐：

```text
remark + mdast
```

---

# 10. ACP Tool Call UI

---

# 10.1 Tool Call 展示

Codex：

```text
正在读取 design.md
```

前端：

```text
[Tool] Reading design.md
```

---

# 10.2 Permission Popup

Codex：

```text
请求修改文件
```

浏览器：

```text
Codex wants to modify design.md

[Allow Once]
[Reject]
```

---

# 11. Patch Apply 详细设计

---

# 11.1 Patch 类型

支持：

* replace
* insert
* delete

---

# 11.2 Apply 流程

```text
Codex Generate Patch
  ↓
UI 显示 Diff
  ↓
User Confirm
  ↓
Apply to AST
  ↓
Write Markdown
```

---

# 11.3 Diff 渲染

推荐：

| 技术               | 用途           |
| ---------------- | ------------ |
| react-diff-view  | diff UI      |
| diff-match-patch | diff compute |

---

# 12. MVP 实现路线

---

# Phase 1

## 功能

支持：

* 打开 markdown
* 浏览器 UI
* Ask Codex
* Thread panel
* 多轮对话

---

## 不做

* patch
* git
* history
* permissions

---

# Phase 2

## 增加

* patch apply
* diff UI
* markdown AST
* undo/redo

---

# Phase 3

## 增加

* Git integration
* Mermaid rendering
* export
* MCP support
* plugin system

---

# 13. 推荐技术栈

---

# Frontend

| 技术              | 用途       |
| --------------- | -------- |
| React           | UI       |
| Vite            | build    |
| CodeMirror 6    | editor + range decoration |
| Zustand         | state    |
| Tailwind        | style    |
| Floating UI     | popup    |
| markdown-it     | markdown preview |
| Mermaid         | diagram rendering |
| react-diff-view | diff     |

---

# Backend

| 技术                | 用途           |
| ----------------- | ------------ |
| TypeScript/Node   | server       |
| ws 或 SSE          | realtime     |
| sidecar JSON      | MVP thread persistence |
| SQLite            | Phase 2 persistence |
| chokidar/fs.watch | file watch   |
| unified/remark    | markdown index / AST |

---

# AI

| 技术     | 用途                  |
| ------ | ------------------- |
| ACP    | Codex communication |
| codex-acp | local Codex ACP adapter |
| OpenAI | optional fallback, not MVP |
| Claude | optional long context, not MVP |

---

# 14. 目录结构建议

```text
xuanniao/
├── cmd/
│   └── xuanniao/
├── internal/
│   ├── acp/
│   ├── markdown/
│   ├── patch/
│   ├── thread/
│   ├── websocket/
│   └── session/
├── web/
│   ├── src/
│   ├── components/
│   ├── pages/
│   └── hooks/
└── docs/
```

---

# 15. 最关键的设计原则

---

# 原则一：Document-centric

不是 Chat-centric。

---

# 原则二：Thread 绑定段落

Thread 必须绑定：

```text
blockId
```

---

# 原则三：Patch First

AI 最终应该输出：

```diff
patch
```

而不是纯聊天。

---

# 原则四：ACP Session 长生命周期

一个 Markdown 文件：

对应一个 ACP session。

不要频繁创建 session。

MVP 约束：

* 同一个文档内多个 UI thread 可以共享一个 ACP session
* server 必须串行化同一个 ACP session 的 prompt
* UI thread 历史由 玄鸟 自己保存
* ACP session 用于保持 Codex 的工作上下文
* 如果后续发现上下文污染严重，再增加 thread-level session 策略
