import { XuanniaoLogo } from "./XuanniaoLogo";

type TopBarProps = {
  documentPath: string;
  status: string;
  onOpenFileManager: () => void;
  onSave: () => void;
};

export function TopBar({ documentPath, status, onOpenFileManager, onSave }: TopBarProps) {
  const fileName = documentPath.split(/[\\/]/).pop() || documentPath;
  const directory = documentPath.slice(0, Math.max(documentPath.length - fileName.length - 1, 0));

  return (
    <header className="topbar">
      <div className="brand">
        <XuanniaoLogo />
        <button type="button" className="documentSwitcher" onClick={onOpenFileManager} title="Open Markdown file">
          <h1>玄鸟</h1>
          <p><strong>{fileName}</strong><span>{directory}</span></p>
        </button>
      </div>
      <div className="actions">
        <span className="status">{status}</span>
        <button type="button" onClick={onSave}>Save</button>
      </div>
    </header>
  );
}
