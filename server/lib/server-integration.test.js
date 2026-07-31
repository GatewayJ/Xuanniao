import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { documentMetadataDirFor } from "./metadata-paths.js";

const serverEntry = fileURLToPath(new URL("../index.js", import.meta.url));

test("HTTP server starts without Agent availability and reports failed turns explicitly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-server-integration-"));
  const documentPath = path.join(tempDir, "plan.md");
  const metadataDir = documentMetadataDirFor(documentPath);
  const port = await availablePort();
  await writeFile(documentPath, "# Plan\n", "utf8");

  const child = spawn(process.execPath, [serverEntry, documentPath], {
    cwd: tempDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      XUANNIAO_CODEX_CMD: "xuanniao-missing-codex-command"
    }
  });

  try {
    await waitForOutput(child, /Open http:\/\/127\.0\.0\.1:/);
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await jsonRequest(`${baseUrl}/api/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.agent.initialized, false);
    assert.equal(health.payload.agent.running, false);

    const document = await jsonRequest(`${baseUrl}/api/document`);
    assert.equal(document.payload.content, "# Plan\n");

    const staleSave = await jsonRequest(`${baseUrl}/api/document`, {
      method: "PUT",
      body: {
        documentPath: path.join(tempDir, "other.md"),
        content: "wrong document",
        expectedRevision: document.payload.revision,
        threads: []
      }
    });
    assert.equal(staleSave.response.status, 409);
    assert.equal((await jsonRequest(`${baseUrl}/api/document`)).payload.content, "# Plan\n");

    const created = await jsonRequest(`${baseUrl}/api/threads`, {
      method: "POST",
      body: {
        documentPath,
        title: "Plan",
        selectedText: "Plan",
          anchor: {
          start: 2,
          end: 6,
          lineStart: 1,
          lineEnd: 1,
            blockId: null
          },
          expectedRevision: document.payload.revision
      }
    });
    assert.equal(created.response.status, 201);

    const rootQuestion = await jsonRequest(
      `${baseUrl}/api/threads/${encodeURIComponent(created.payload.thread.id)}/messages`,
      {
        method: "POST",
        body: {
          content: "Root question",
          askAgent: false
        }
      }
    );
    assert.equal(rootQuestion.response.status, 200);

    const obsoletePlacement = await jsonRequest(
      `${baseUrl}/api/threads/${encodeURIComponent(created.payload.thread.id)}/messages`,
      {
        method: "POST",
        body: {
          content: "Do not reparent",
          askAgent: false,
          parentMessageId: rootQuestion.payload.userMessage.id,
          adoptExistingChildren: true
        }
      }
    );
    assert.equal(obsoletePlacement.response.status, 400);
    const afterRejectedPlacement = await jsonRequest(`${baseUrl}/api/threads`);
    assert.deepEqual(
      afterRejectedPlacement.payload.threads[0].messages.map((message) => message.content),
      ["Root question"]
    );

    const reply = await jsonRequest(
      `${baseUrl}/api/threads/${encodeURIComponent(created.payload.thread.id)}/messages`,
      {
        method: "POST",
        body: {
          content: "Review this",
          askAgent: true,
          parentMessageId: rootQuestion.payload.userMessage.id
        }
      }
    );
    assert.equal(reply.response.status, 200);
    assert.equal(reply.payload.agentOutcome, "failed");
    assert.equal(reply.payload.assistantMessage.error, true);
  } finally {
    child.kill();
    await waitForExit(child);
    await rm(tempDir, { recursive: true, force: true });
    await rm(metadataDir, { recursive: true, force: true });
  }
});

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function jsonRequest(url, { method = "GET", body } = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (response) => ({
    response,
    payload: await response.json()
  }));
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`server did not become ready: ${output}`));
    }, 5000);
    const accept = (chunk) => {
      output += chunk;
      if (!pattern.test(output)) return;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", accept);
      child.stderr.off("data", accept);
      child.off("error", fail);
      child.off("exit", handleExit);
    };
    const handleExit = (code) => fail(new Error(`server exited before readiness with code ${code}: ${output}`));
    child.stdout.on("data", accept);
    child.stderr.on("data", accept);
    child.once("error", fail);
    child.once("exit", handleExit);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
