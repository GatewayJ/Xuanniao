import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { api } from "../api.ts";
import {
  ConversationSendRegistry,
  conversationRevisionCommand,
  conversationRevisionKey,
  conversationSendKey,
  useConversationCommands,
  statusForOutcome
} from "./useConversationCommands.ts";
import type { Thread } from "../types.ts";

test("agent failures are not presented as successful answers", () => {
  assert.equal(statusForOutcome("completed", "Codex 已回答"), "Codex 已回答");
  assert.equal(statusForOutcome("not-requested", "评论已保存"), "评论已保存");
  assert.equal(statusForOutcome("failed", "Codex 已回答"), "Codex 请求失败，请查看错误回答");
});

test("send keys serialize questions targeting the same conversation position", () => {
  assert.equal(
    conversationSendKey({
      threadId: "thread-1",
      content: "one",
      draftKey: "draft-a",
      askAgent: true,
      parentMessageId: "node-1"
    }),
    conversationSendKey({
      threadId: "thread-1",
      content: "two",
      draftKey: "draft-b",
      askAgent: true,
      parentMessageId: "node-1"
    })
  );
});

test("send registry rejects a duplicate until its exact owner finishes", () => {
  const registry = new ConversationSendRegistry();
  const first = registry.begin("thread-1:node-1");
  assert.ok(first);
  assert.equal(registry.begin("thread-1:node-1"), null);

  registry.finish("thread-1:node-1", Symbol("stale"));
  assert.equal(registry.begin("thread-1:node-1"), null);

  registry.finish("thread-1:node-1", first);
  assert.ok(registry.begin("thread-1:node-1"));
});

test("editing a historical child targets its parent and therefore creates a sibling leaf", () => {
  assert.deepEqual(
    conversationRevisionCommand(
      "thread-1",
      {
        id: "child",
        role: "user",
        content: "old",
        nodeId: "child",
        parentId: "root",
        createdAt: "2026-08-21T00:00:00.000Z"
      },
      "new",
      "run_12345678"
    ),
    {
      threadId: "thread-1",
      content: "new",
      draftKey: null,
      askAgent: true,
      nodeId: null,
      parentMessageId: "root",
      agentRunId: "run_12345678"
    }
  );
});

test("revision submissions use a stable per-message registry key", () => {
  assert.equal(
    conversationRevisionKey("thread-1", "message-1"),
    conversationRevisionKey("thread-1", "message-1")
  );
  assert.notEqual(
    conversationRevisionKey("thread-1", "message-1"),
    conversationRevisionKey("thread-1", "message-2")
  );
});

test("a same-tick question can be sent for a thread just created by the caller", async () => {
  const threadsRef = { current: [] as Thread[] };
  const statuses: string[] = [];
  let commands!: ReturnType<typeof useConversationCommands>;
  let queued = false;
  let sentThreadId: string | null = null;
  const originalSendMessage = api.sendMessage;

  api.sendMessage = async (threadId) => {
    assert.equal(queued, true);
    sentThreadId = threadId;
    return {
      userMessage: {
        id: "question-1",
        role: "user",
        content: "first question",
        createdAt: "2026-08-19T00:00:00.000Z"
      },
      assistantMessage: null,
      agentOutcome: "not-requested",
      threads: []
    };
  };

  function Harness() {
    commands = useConversationCommands({
      documentPath: "/workspace/document.md",
      threadsRef,
      setThreads: () => undefined,
      setActiveThreadId: () => undefined,
      setStatus: (value) => {
        statuses.push(typeof value === "function" ? value(statuses.at(-1) || "") : value);
      },
      flushDocumentSave: async () => true,
      applyDocument: () => true,
      captureDocumentSession: () => ({
        epoch: 1,
        signal: new AbortController().signal
      }),
      isDocumentSessionCurrent: () => true
    });
    return null;
  }

  try {
    renderToString(createElement(Harness));
    const sent = await commands.send(
      {
        threadId: "new-thread",
        content: "first question",
        draftKey: null,
        askAgent: false
      },
      { onQueued: () => { queued = true; } }
    );

    assert.equal(sent, true);
    assert.equal(queued, true);
    assert.equal(sentThreadId, "new-thread");
    assert.equal(statuses.at(-1), "评论已保存");
  } finally {
    api.sendMessage = originalSendMessage;
  }
});
