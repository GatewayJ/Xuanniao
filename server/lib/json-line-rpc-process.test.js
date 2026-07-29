import assert from "node:assert/strict";
import test from "node:test";

import { JsonLineRpcProcess } from "./json-line-rpc-process.js";

function testProcess(onMessage = () => {}) {
  const writes = [];
  const rpc = new JsonLineRpcProcess({
    label: "Test RPC",
    commandLine: "unused",
    cwd: "/tmp",
    env: {},
    timeoutMs: 100,
    emptyCommandMessage: "missing command",
    onMessage
  });
  rpc.process = {
    killed: false,
    stdin: {
      writable: true,
      write(line) {
        writes.push(JSON.parse(line));
      }
    },
    kill() {
      this.killed = true;
    }
  };
  return { rpc, writes };
}

test("JSON line RPC correlates responses and forwards notifications", async () => {
  const messages = [];
  const { rpc, writes } = testProcess((message) => messages.push(message));
  const response = rpc.request("method", { value: 1 });
  assert.deepEqual(writes, [{ id: 1, method: "method", params: { value: 1 } }]);
  rpc.acceptChunk('{"method":"event","params":{"ok":true}}\n{"id":1,"result":{"done":true}}\n');
  assert.deepEqual(await response, { done: true });
  assert.deepEqual(messages, [{ method: "event", params: { ok: true } }]);
});

test("JSON line RPC retains bounded diagnostics for malformed output", () => {
  const { rpc } = testProcess();
  rpc.acceptChunk("not-json\n");
  assert.match(rpc.stderrTail, /Invalid Test RPC JSON/);
  assert.ok(rpc.stderrTail.length <= 4000);
});
