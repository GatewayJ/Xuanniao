import { useCallback, useEffect, useRef, useState } from "react";
import { projectApi } from "../project-api";
import type { ReferenceCheck } from "../project-api";
import type { ReferenceSnapshot } from "../types";

export function useReferenceChecks(references: ReferenceSnapshot[], enabled = true) {
  const [checks, setChecks] = useState<Record<string, ReferenceCheck>>({});
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  // Message renderers may recreate the same array on each render.
  const signature = JSON.stringify(references);
  const latest = useRef(references);
  latest.current = references;
  useEffect(() => {
    if (!enabled || !latest.current.length) { setChecks({}); setChecking(false); setError(""); return; }
    const controller = new AbortController();
    setChecking(true);
    setError("");
    projectApi.checkReferences(latest.current, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setChecks(Object.fromEntries(result.map((check) => [check.id, check]))); })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "无法检查引用版本"); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [signature, enabled, refreshIndex]);
  const refresh = useCallback(() => setRefreshIndex((value) => value + 1), []);
  return { checks, checking, error, refresh };
}
