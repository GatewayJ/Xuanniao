import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api.ts";
import { DocumentSessionScope } from "../document-session-scope.ts";
import type { DocumentSessionOperation } from "../document-session-scope.ts";
import type { PermissionRequest } from "../types";

type PermissionInboxOptions = {
  setStatus: (status: string) => void;
  sessionKey: string | null;
  pollIntervalMs?: number;
};

export function usePermissionInbox({
  setStatus,
  sessionKey,
  pollIntervalMs = 900
}: PermissionInboxOptions) {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(() => new Set());
  const sessionScopeRef = useRef(new DocumentSessionScope());
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  const replaceRequests = useCallback((next: PermissionRequest[]) => {
    setRequests((current) => samePermissionRequests(current, next) ? current : next);
  }, []);

  useEffect(() => {
    sessionScopeRef.current.advance();
    replaceRequests([]);
    setResolvingIds(new Set());
  }, [sessionKey, replaceRequests]);

  useEffect(() => () => sessionScopeRef.current.dispose(), []);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;

    async function poll() {
      const operation = capturePermissionOperation(sessionKey, sessionScopeRef.current);
      try {
        const payload = await api.permissions(operation.signal);
        if (!stopped && isPermissionOperationCurrent(operation, sessionKeyRef.current, sessionScopeRef.current)) {
          replaceRequests(payload.requests);
        }
      } catch {
        if (!stopped && isPermissionOperationCurrent(operation, sessionKeyRef.current, sessionScopeRef.current)) {
          replaceRequests([]);
        }
      } finally {
        if (!stopped) timer = window.setTimeout(poll, pollIntervalMs);
      }
    }

    void poll();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pollIntervalMs, replaceRequests, sessionKey]);

  async function resolve(requestId: string, optionId: string | null) {
    const operation = capturePermissionOperation(sessionKey, sessionScopeRef.current);
    setResolvingIds((current) => new Set(current).add(requestId));
    setStatus(optionId ? "正在发送权限决定" : "正在取消权限请求");
    try {
      const payload = await api.resolvePermission(
        requestId,
        optionId ? { optionId } : { cancelled: true },
        operation.signal
      );
      if (!isPermissionOperationCurrent(operation, sessionKeyRef.current, sessionScopeRef.current)) return;
      replaceRequests(payload.requests);
      setStatus("权限决定已发送");
    } catch (error) {
      if (!isPermissionOperationCurrent(operation, sessionKeyRef.current, sessionScopeRef.current)) return;
      setStatus(error instanceof Error ? error.message : String(error));
      try {
        const payload = await api.permissions(operation.signal);
        if (isPermissionOperationCurrent(operation, sessionKeyRef.current, sessionScopeRef.current)) {
          replaceRequests(payload.requests);
        }
      } catch {
        if (isPermissionOperationCurrent(operation, sessionKeyRef.current, sessionScopeRef.current)) {
          replaceRequests([]);
        }
      }
    } finally {
      if (isPermissionOperationCurrent(operation, sessionKeyRef.current, sessionScopeRef.current)) {
        setResolvingIds((current) => {
          const next = new Set(current);
          next.delete(requestId);
          return next;
        });
      }
    }
  }

  return {
    permissionRequests: requests,
    resolvingPermissionIds: resolvingIds,
    resolvePermissionRequest: resolve
  };
}

type PermissionSessionOperation = DocumentSessionOperation & {
  sessionKey: string | null;
};

function capturePermissionOperation(
  sessionKey: string | null,
  scope: DocumentSessionScope
): PermissionSessionOperation {
  return { ...scope.capture(), sessionKey };
}

export function isPermissionOperationCurrent(
  operation: PermissionSessionOperation,
  currentSessionKey: string | null,
  scope: DocumentSessionScope
): boolean {
  return operation.sessionKey === currentSessionKey && scope.isCurrent(operation);
}

export function samePermissionRequests(left: PermissionRequest[], right: PermissionRequest[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((request, index) => samePermissionRequest(request, right[index]));
}

function samePermissionRequest(
  left: PermissionRequest,
  right: PermissionRequest | undefined
): boolean {
  return Boolean(
    right &&
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.threadId === right.threadId &&
    left.sourceThreadId === right.sourceThreadId &&
    left.sourceAgentName === right.sourceAgentName &&
    left.toolCallId === right.toolCallId &&
    left.title === right.title &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.rawInput === right.rawInput &&
    left.createdAt === right.createdAt &&
    left.options.length === right.options.length &&
    left.options.every((option, index) => (
      option.optionId === right.options[index]?.optionId &&
      option.name === right.options[index]?.name &&
      option.kind === right.options[index]?.kind
    ))
  );
}
