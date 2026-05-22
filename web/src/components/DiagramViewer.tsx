import { useEffect, useState } from "react";

type DiagramViewerProps = {
  diagram: {
    title: string;
    svg: string;
  } | null;
  onClose: () => void;
};

export function DiagramViewer({ diagram, onClose }: DiagramViewerProps) {
  const [zoom, setZoom] = useState(1);
  const size = diagram ? diagramSvgSize(diagram.svg) : null;

  useEffect(() => {
    setZoom(1);
  }, [diagram?.svg]);

  useEffect(() => {
    if (!diagram) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [diagram, onClose]);

  if (!diagram) return null;

  return (
    <div className="diagramModalBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="diagramModal" role="dialog" aria-modal="true" aria-labelledby="diagram-viewer-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="diagramModalHeader">
          <h2 id="diagram-viewer-title">{diagram.title}</h2>
          <div className="diagramModalActions">
            <button type="button" onClick={() => setZoom((current) => Math.max(0.35, current - 0.15))}>-</button>
            <button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((current) => Math.min(3, current + 0.15))}>+</button>
            <button type="button" className="primaryButton" onClick={onClose}>Close</button>
          </div>
        </header>
        <div className="diagramModalCanvas">
          <div
            className="diagramModalSvg"
            style={{
              width: size ? `${size.width * zoom}px` : undefined,
              minWidth: size ? `${size.width * zoom}px` : undefined
            }}
            dangerouslySetInnerHTML={{ __html: diagram.svg }}
          />
        </div>
      </section>
    </div>
  );
}

function diagramSvgSize(svg: string): { width: number; height: number } | null {
  const viewBox = /\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/.exec(svg);
  if (viewBox) {
    return {
      width: Math.max(Number(viewBox[1]) || 0, 560),
      height: Math.max(Number(viewBox[2]) || 0, 320)
    };
  }

  const width = /\bwidth=["']([\d.]+)/.exec(svg);
  const height = /\bheight=["']([\d.]+)/.exec(svg);
  if (!width || !height) return null;
  return {
    width: Math.max(Number(width[1]) || 0, 560),
    height: Math.max(Number(height[1]) || 0, 320)
  };
}
