import { useCallback, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const STORAGE_KEY = "xuanniao.threadWidth.v1";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 320;
const MAX_WIDTH = 560;

export function useThreadPaneWidth() {
  const [threadWidth, setThreadWidth] = useState(() => clampWidth(Number(localStorage.getItem(STORAGE_KEY) || DEFAULT_WIDTH)));

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    document.body.classList.add("resizing");

    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(Math.max(window.innerWidth - moveEvent.clientX - 24, MIN_WIDTH), MAX_WIDTH);
      setThreadWidth(width);
      localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
    };
    const stop = () => {
      document.body.classList.remove("resizing");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
  }, []);

  return { threadWidth, startResize };
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH);
}
