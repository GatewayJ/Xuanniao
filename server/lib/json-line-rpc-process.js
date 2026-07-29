import { spawn } from "node:child_process";

import { parseCommandLine } from "./agent-config.js";

export class JsonLineRpcProcess {
  constructor({
    label,
    commandLine,
    cwd,
    env,
    timeoutMs,
    emptyCommandMessage,
    formatRequest = ({ id, method, params }) => ({ id, method, params }),
    onMessage = () => {},
    onExit = () => {}
  }) {
    this.label = label;
    this.commandLine = commandLine;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.emptyCommandMessage = emptyCommandMessage;
    this.formatRequest = formatRequest;
    this.onMessage = onMessage;
    this.onExit = onExit;
    this.protocolId = 0;
    this.pending = new Map();
    this.process = null;
    this.stdoutBuffer = "";
    this.stderrTail = "";
  }

  get running() {
    return Boolean(this.process && !this.process.killed);
  }

  async start() {
    if (this.running) return;
    const [command, ...args] = parseCommandLine(this.commandLine);
    if (!command) throw new Error(this.emptyCommandMessage);

    const child = spawn(command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env
    });
    this.process = child;
    this.stdoutBuffer = "";
    this.stderrTail = "";

    await new Promise((resolve, reject) => {
      const handleSpawn = () => {
        child.off("error", handleStartupError);
        resolve();
      };
      const handleStartupError = (error) => {
        child.off("spawn", handleSpawn);
        if (this.process === child) this.process = null;
        reject(new Error(`Failed to start ${this.label} command '${command}': ${error.message}`));
      };
      child.once("spawn", handleSpawn);
      child.once("error", handleStartupError);
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.process === child) this.acceptChunk(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (this.process === child) this.appendDiagnostic(chunk);
    });
    child.on("error", (error) => {
      if (this.process === child) this.failAll(error);
    });
    child.on("close", (code) => {
      if (this.process !== child) return;
      const detail = this.stderrTail ? `\n\nstderr:\n${this.stderrTail}` : "";
      const error = new Error(`${this.label} process exited with code ${code}.${detail}`);
      this.process = null;
      this.failAll(error);
      this.onExit(error);
    });
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = ++this.protocolId;
    const payload = this.formatRequest({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  write(payload) {
    if (!this.process?.stdin?.writable) {
      throw new Error(`${this.label} process is not writable.`);
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  acceptChunk(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.acceptLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  acceptLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.appendDiagnostic(`\nInvalid ${this.label} JSON: ${line}`);
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`${pending.method} failed: ${message.error.message || JSON.stringify(message.error)}`)
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.onMessage(message);
  }

  appendDiagnostic(value) {
    this.stderrTail = `${this.stderrTail}${value}`.slice(-4000);
  }

  failAll(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  kill() {
    if (this.process && !this.process.killed) this.process.kill();
  }

  dispose(error = new Error(`${this.label} process closed.`)) {
    this.failAll(error);
    this.kill();
    this.process = null;
    this.stdoutBuffer = "";
  }
}
