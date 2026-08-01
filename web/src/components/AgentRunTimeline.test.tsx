import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentRunState, Message } from "../types";
import { AgentRunTimeline } from "./AgentRunTimeline";

test("floating progress renders the current plan, diff totals, and expandable subagents", () => {
  const html = renderToStaticMarkup(
    <AgentRunTimeline
      variant="floating"
      message={messageWithRun({
        status: "running",
        events: [
          {
            type: "plan",
            itemId: "plan",
            plan: [
              { step: "检查实现", status: "completed" },
              { step: "实现进度视图", status: "inProgress" },
              { step: "运行验证", status: "pending" }
            ]
          },
          { type: "diff", itemId: "diff", filesChanged: 2, additions: 32, deletions: 4 },
          {
            type: "subagent",
            itemId: "agent-1",
            scope: "subagent",
            agentThreadId: "agent-1",
            agentName: "审查员",
            agentRole: "reviewer",
            task: "检查事件归一化",
            model: "gpt-5",
            agentStatus: "running"
          },
          {
            type: "commandExecution",
            itemId: "command-1",
            scope: "subagent",
            agentThreadId: "agent-1",
            command: "npm test",
            status: "inProgress"
          }
        ]
      })}
    />
  );

  assert.match(html, /agentRunTimeline running floating/);
  assert.match(html, /第 2\/3 步/);
  assert.match(html, /1 个 Subagent/);
  assert.match(html, /2 个文件/);
  assert.match(html, /\+32/);
  assert.match(html, /检查事件归一化/);
  assert.match(html, /npm test/);
});

test("running tasks without a plan use the generic Codex progress state", () => {
  const html = renderToStaticMarkup(
    <AgentRunTimeline
      variant="floating"
      message={messageWithRun({
        status: "running",
        events: [{ type: "reasoning", itemId: "reasoning", status: "inProgress" }]
      })}
    />
  );

  assert.match(html, /Codex 正在执行/);
  assert.match(html, /尚未发布计划/);
});

test("completed and failed runs render as collapsed inline archives", () => {
  const completed = renderToStaticMarkup(
    <AgentRunTimeline message={messageWithRun({ status: "completed", events: [{ type: "plan", itemId: "plan", plan: [{ step: "完成", status: "completed" }] }] })} />
  );
  const failed = renderToStaticMarkup(
    <AgentRunTimeline message={messageWithRun({ status: "failed", error: "boom", events: [{ type: "error", message: "boom", status: "failed" }] })} />
  );

  assert.match(completed, /agentRunTimeline terminal inline/);
  assert.match(completed, /执行留档/);
  assert.doesNotMatch(completed, /agentRunPrimaryPlan/);
  assert.match(failed, /执行失败/);
});

test("interrupted subagents retain their terminal state in the archive", () => {
  const html = renderToStaticMarkup(
    <AgentRunTimeline
      variant="floating"
      message={messageWithRun({
        status: "completed",
        events: [{
          type: "subagent",
          itemId: "agent-1",
          scope: "subagent",
          agentThreadId: "agent-1",
          agentName: "检索员",
          agentStatus: "interrupted"
        }]
      })}
    />
  );

  assert.match(html, /检索员/);
  assert.match(html, /已中断/);
});

test("errored and missing subagents render as failed", () => {
  for (const agentStatus of ["errored", "notFound"]) {
    const html = renderToStaticMarkup(
      <AgentRunTimeline
        variant="floating"
        message={messageWithRun({
          status: "completed",
          events: [{
            type: "subagent",
            itemId: `agent-${agentStatus}`,
            scope: "subagent",
            agentThreadId: `agent-${agentStatus}`,
            agentName: agentStatus,
            agentStatus,
            status: "failed"
          }]
        })}
      />
    );

    assert.match(html, new RegExp(`agentRunSubagent failed[\\s\\S]*${agentStatus}`));
    assert.match(html, /失败/);
    assert.doesNotMatch(html, /执行中/);
  }
});

function messageWithRun(overrides: Partial<AgentRunState>): Message {
  const run: AgentRunState = {
    id: "run_component1",
    status: "running",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
    events: [],
    ...overrides
  };
  return {
    id: "pending-agent-run_component1",
    role: "assistant",
    content: "",
    meta: { agentRun: run, model: "gpt-5", reasoningEffort: "high" },
    createdAt: "2026-08-02T00:00:00.000Z"
  };
}
