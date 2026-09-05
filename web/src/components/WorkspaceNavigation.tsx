import { useDiscussionWorkspace } from "./DiscussionWorkspaceContext";
import { appliedOutcomeCount } from "./OutcomeReview";

const styles = new URL("./workspace-navigation.css", import.meta.url).href;

export function WorkspaceNavigation({ placement, hidden = false }: { placement: "workspace" | "discussion"; hidden?: boolean }) {
  const workspace = useDiscussionWorkspace();
  if (!workspace || hidden) return null;
  return <>
    <link rel="stylesheet" href={styles} precedence="workspace-navigation" />
    <nav className={`workspaceNavigation workspaceNavigation-${placement}`} aria-label="项目与成果">
      {workspace.openProject && <button type="button" onClick={workspace.openProject}>◈ 项目总览</button>}
      <button type="button" onClick={() => workspace.openResults()}>成果记录 <b>{workspace.records.length}</b> · 已应用 {appliedOutcomeCount(workspace.records)}</button>
      {workspace.activityLabel && <span className="workspaceNavigationStatus" role="status">{workspace.activityLabel}</span>}
      {(workspace.activityLabel || workspace.busy) && <button type="button" disabled={!workspace.canStop} onClick={workspace.stop}>停止当前执行</button>}
    </nav>
  </>;
}
