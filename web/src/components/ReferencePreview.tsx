import { useRef, useState } from "react";
import type { ReferenceSnapshot } from "../types";
import { useReferenceChecks } from "../hooks/useReferenceChecks";
import type { ReferenceCheck } from "../project-api";
import { OutcomeReferenceState, SourceSnapshot, WorkspaceDialog } from "./OutcomeReview";

type Props = {
  reference: ReferenceSnapshot; busy: boolean; onClose(): void; onOpen(reference: ReferenceSnapshot, locate: boolean): Promise<void>;
};
/** Reading a foreign source never changes the active document or its scroll position. */
export function ReferencePreview(props: Props) {
  const { checks, checking, error, refresh } = useReferenceChecks([props.reference]);
  return <ReferencePreviewContent {...props} check={checks[props.reference.id]} checking={checking} error={error} refresh={refresh} />;
}

export function ReferencePreviewContent({ reference, busy, onClose, onOpen, check, checking, error, refresh }: Props & {
  check?: ReferenceCheck; checking: boolean; error: string; refresh(): void;
}) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const pending = useRef(false);
  return <WorkspaceDialog title="引用来源只读预览" onClose={onClose}>
    <p>来源文档：{reference.documentPath}</p>
    <p>预览不切换活动文档、不启动 Agent。确认打开后才进入来源文档。</p>
    <SourceSnapshot source={reference} status={<OutcomeReferenceState check={check} />} />
    <section className="referenceSourcePreview" aria-label="来源内容只读预览">
      <h3>{check?.latest ? "当前来源内容" : "引用时保存的内容"}</h3>
      <pre tabIndex={0}>{check?.latest?.content || reference.content}</pre>
    </section>
    {check?.state === "missing" && <p role="status">来源不可用，历史快照仍可查看。请重新关联后再打开。</p>}
    {check?.state === "changed" && !check.latest && <p role="status">{check.latestUnavailableReason === "reference_too_large" ? "新版来源超过 160,000 字符，请打开来源文档选择更小的片段。" : "新版片段无法唯一定位；打开后请在来源文档中重新查找。"}</p>}
    {(error || openError) && <p role="alert" className="outcomeError">{error || openError}</p>}
    {busy && <p role="status">当前运行结束后可打开来源文档，期间可以继续只读查看。</p>}
    <div className="outcomeButtons">
      <button type="button" disabled={checking} onClick={refresh}>重新检查来源</button>
      <button type="button" className="primary" disabled={busy || opening || checking || !check || check.state === "missing" || Boolean(error)} onClick={() => {
        if (pending.current || busy || opening || checking || !check || check.state === "missing" || error) return;
        pending.current = true; setOpening(true); setOpenError("");
        void onOpen(check.latest || reference, Boolean(check.latest) || check.state === "current").catch((caught) => setOpenError(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => { pending.current = false; setOpening(false); });
      }}>{opening ? "正在打开…" : "打开来源文档"}</button>
    </div>
  </WorkspaceDialog>;
}
