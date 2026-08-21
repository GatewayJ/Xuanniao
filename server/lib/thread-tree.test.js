import assert from "node:assert/strict";
import test from "node:test";

import { branchThreadForQuestion, parentQuestion, selectionComesFromNode } from "./thread-tree.js";

const messages = [
  {
    id: "q-root",
    role: "user",
    content: "Root",
    nodeId: "q-root",
    parentId: null
  },
  {
    id: "a-root",
    role: "assistant",
    content: "Root answer",
    nodeId: "q-root",
    parentId: "q-root"
  },
  {
    id: "q-left",
    role: "user",
    content: "Left",
    nodeId: "q-left",
    parentId: "q-root"
  },
  {
    id: "a-left",
    role: "assistant",
    content: "Left answer",
    nodeId: "q-left",
    parentId: "q-left"
  },
  {
    id: "q-right",
    role: "user",
    content: "Right",
    nodeId: "q-right",
    parentId: "q-root"
  },
  {
    id: "a-right",
    role: "assistant",
    content: "Right answer",
    nodeId: "q-right",
    parentId: "q-right"
  },
  {
    id: "q-leaf",
    role: "user",
    content: "Leaf",
    nodeId: "q-leaf",
    parentId: "q-left",
    agentSession: {
      adapter: "codex-app-server",
      sessionId: "leaf-session",
      turnId: "leaf-turn",
      documentHash: "hash"
    }
  }
];

test("builds agent history from ancestors without sibling branches", () => {
  const branch = branchThreadForQuestion({ id: "thread-1", messages }, "q-leaf");
  assert.equal(branch.sessionKey, "agent:codex-app-server:leaf-session");
  assert.equal(branch.agentSession.sessionId, "leaf-session");
  assert.equal(branch.parentAgentSession, null);
  assert.deepEqual(
    branch.ancestorMessages.map((message) => message.id),
    ["q-root", "a-root", "q-left", "a-left"]
  );
  assert.deepEqual(branch.currentNodeMessages, []);
  assert.deepEqual(
    branch.messages.map((message) => message.id),
    ["q-root", "a-root", "q-left", "a-left"]
  );
});

test("continuing a node includes earlier turns from that node", () => {
  const continued = [
    ...messages.slice(0, 4),
    {
      id: "q-left-follow",
      role: "user",
      content: "Follow up",
      nodeId: "q-left",
      parentId: "q-root"
    }
  ];
  const branch = branchThreadForQuestion({ id: "thread-1", messages: continued }, "q-left-follow");
  assert.equal(branch.sessionKey, "thread-1:q-left");
  assert.deepEqual(
    branch.messages.map((message) => message.id),
    ["q-root", "a-root", "q-left", "a-left"]
  );
});

test("resumed sessions include only local messages added since the last agent reply", () => {
  const continued = [
    {
      id: "q-root",
      role: "user",
      content: "Root",
      nodeId: "q-root",
      parentId: null,
      agentSession: {
        adapter: "codex-app-server",
        sessionId: "session-1",
        turnId: "turn-1",
        documentHash: "hash"
      }
    },
    {
      id: "a-root",
      role: "assistant",
      content: "Root answer",
      nodeId: "q-root",
      parentId: "q-root",
      meta: { transport: "codex-app-server" }
    },
    { id: "q-local", role: "user", content: "A local note", nodeId: "q-root", parentId: null },
    { id: "q-next", role: "user", content: "Continue", nodeId: "q-root", parentId: null }
  ];

  const branch = branchThreadForQuestion({ id: "thread-1", messages: continued }, "q-next");
  assert.equal(branch.sessionKey, "agent:codex-app-server:session-1");
  assert.deepEqual(
    branch.unsyncedCurrentNodeMessages.map((message) => message.id),
    ["q-local"]
  );
});

test("a child of an interrupted claim rebuilds history instead of inheriting it", () => {
  const interrupted = [
    {
      id: "q-root",
      role: "user",
      content: "Root",
      nodeId: "q-root",
      parentId: null,
      agentSession: {
        adapter: "codex-app-server",
        sessionId: "session-1",
        turnId: "turn-1",
        documentHash: "hash"
      }
    },
    {
      id: "a-root",
      role: "assistant",
      content: "Root answer",
      nodeId: "q-root",
      parentId: "q-root"
    },
    {
      id: "q-interrupted",
      role: "user",
      content: "Interrupted",
      nodeId: "q-interrupted",
      parentId: "q-root",
      agentSessionClaim: {
        adapter: "codex-app-server",
        sessionId: "session-1",
        turnId: "turn-1",
        documentHash: "hash"
      }
    },
    {
      id: "q-grandchild",
      role: "user",
      content: "Continue after interruption",
      nodeId: "q-grandchild",
      parentId: "q-interrupted"
    }
  ];

  const branch = branchThreadForQuestion({ id: "thread-1", messages: interrupted }, "q-grandchild");
  assert.equal(branch.agentSession, null);
  assert.equal(branch.parentAgentSession, null);
  assert.deepEqual(
    branch.messages.map((message) => message.id),
    ["q-root", "a-root", "q-interrupted"]
  );
});

test("carries a selected parent excerpt into a new child branch", () => {
  const quoted = [
    ...messages,
    {
      id: "q-quoted",
      role: "user",
      content: "Explain this",
      nodeId: "q-quoted",
      parentId: "q-left",
      meta: {
        branchSelection: {
          sourceMessageId: "a-left",
          text: "selected answer text"
        }
      }
    }
  ];
  const branch = branchThreadForQuestion({ id: "thread-1", messages: quoted }, "q-quoted");
  assert.deepEqual(branch.branchSelection, {
    sourceMessageId: "a-left",
    text: "selected answer text"
  });
});

test("carries a selected excerpt into a continued turn in the same node", () => {
  const continued = [
    ...messages.slice(0, 4),
    {
      id: "q-left-follow",
      role: "user",
      content: "Explain only this part",
      nodeId: "q-left",
      parentId: "q-root",
      meta: {
        branchSelection: { sourceMessageId: "a-left", text: "focused excerpt" }
      }
    }
  ];
  const branch = branchThreadForQuestion({ id: "thread-1", messages: continued }, "q-left-follow");
  assert.deepEqual(branch.branchSelection, {
    sourceMessageId: "a-left",
    text: "focused excerpt"
  });
});

test("validates that child questions target a user question", () => {
  const thread = { messages };
  assert.equal(parentQuestion(thread, null), null);
  assert.equal(parentQuestion(thread, "q-left").id, "q-left");
  assert.throws(() => parentQuestion(thread, "a-left"), /parent question not found/);
});

test("validates selected text against the current or parent conversation node", () => {
  const thread = { messages };
  const selection = { sourceMessageId: "a-left", text: "Left answer" };
  assert.equal(selectionComesFromNode(thread, selection, "q-left"), true);
  assert.equal(selectionComesFromNode(thread, selection, "q-root"), false);
  assert.equal(selectionComesFromNode(thread, { ...selection, sourceMessageId: "missing" }, "q-left"), false);
});
