import type { ConversationNode } from "../thread-tree";

export type ReferenceContextKind = "scope" | "history" | "selection";
export const referenceContextLabels = { scope: "文档背景", history: "分支历史", selection: "原文选区" };

export function ReferenceContextPreview({ id, kind, scope, inheritsHistory, history = [], selectedText, selectionUnavailable, onClose }: {
  id: string; kind: ReferenceContextKind; scope?: "full" | "references"; inheritsHistory?: boolean;
  history?: ConversationNode[]; selectedText?: string; selectionUnavailable?: boolean; onClose(): void;
}) {
  return <section id={id} className="referenceContextPreview" aria-label={referenceContextLabels[kind]}>
    <header><strong>{referenceContextLabels[kind]}</strong><button type="button" aria-label="收起参考说明" onClick={onClose}>收起 ×</button></header>
    {kind === "scope" && <p>{scope === "references" ? "本轮不主动附带完整文档或原文选区。" : "首次提供完整 Markdown，后续同步变化。原文选区是本次关注点，不限制背景范围。"}<br />资料范围不改变 Codex 的文件访问权限。</p>}
    {kind === "selection" && <>
      <p>{selectionUnavailable ? "原位置已变化，下面保留讨论中保存的原文选区。" : "这段原文是本次讨论的关注点。"}</p>
      <pre tabIndex={0} aria-label="完整原文选区">{selectedText}</pre>
    </>}
    {kind === "history" && <>
      <p>{inheritsHistory ? "沿用从根问题到当前节点的分支；移除本轮引用不会清除已有历史。" : "新讨论不继承其他分支历史。"}</p>
      {history.length > 0 ? <div className="referenceBranchHistory" tabIndex={0} aria-label="分支问答记录">
        {history.map((node, index) => <details key={node.id}>
          <summary>{index + 1}. {node.question.content.replace(/\s+/g, " ").slice(0, 80) || "未命名问题"}</summary>
          {node.messages.map((message) => <div key={message.id}><strong>{message.role === "user" ? "问题" : "回答"}</strong><pre>{message.content}</pre></div>)}
        </details>)}
      </div> : inheritsHistory && <p>分支问答暂不可用，请到来源讨论查看。</p>}
      {inheritsHistory && <small>这里展示已保存的问答；原生会话还可能包含工具调用等执行过程。</small>}
    </>}
  </section>;
}
