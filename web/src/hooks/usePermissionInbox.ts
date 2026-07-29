import { useCallback, useEffect, useState } from "react";

import { api } from "../api.ts";
import type { PermissionRequest } from "../types";

type PermissionInboxOptions = {
  setStatus: (status: string) => void;
  pollIntervalMs?: number;
};

export function usePermissionInbox({
  setStatus,
  pollIntervalMs = 900
}: PermissionInboxOptions) {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(() => new Set());

  const replaceRequests = useCallback((next: PermissionRequest[]) => {
    setRequests((current) => samePermissionRequests(current, next) ? current : next);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;

    async function poll() {
      try {
        const payload = await api.permissions();
        if (!stopped) replaceRequests(payload.requests);
      } catch {
        if (!stopped) replaceRequests([]);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, pollIntervalMs);
      }
    }

    void poll();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pollIntervalMs, replaceRequests]);

  async function resolve(requestId: string, optionId: string | null) {
    setResolvingIds((current) => new Set(current).add(requestId));
    setStatus(optionId ? "正在发送权限决定" : "正在取消权限请求");
    try {
      const payload = await api.resolvePermission(
        requestId,
        optionId ? { optionId } : { cancelled: true }
      );
      replaceRequests(payload.requests);
      setStatus("权限决定已发送");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      try {
        replaceRequests((await api.permissions()).requests);
      } catch {
        replaceRequests([]);
      }
    } finally {
      setResolvingIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  }

  return {
    permissionRequests: requests,
    resolvingPermissionIds: resolvingIds,
    resolvePermissionRequest: resolve
  };
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
