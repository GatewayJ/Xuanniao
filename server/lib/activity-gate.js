import { randomUUID } from "node:crypto";

export class WorkspaceBusyError extends Error {
  constructor(message = "当前工作仍在执行或停止中，请等待结束后再操作。") {
    super(message);
    this.statusCode = 409;
    this.code = "WORKSPACE_BUSY";
  }
}

// One foreground operation per document. Callers reject competing work instead of queuing it.
export class ActivityGate {
  current = null;
  blocker = () => false;
  blockedActivity = null;

  get active() {
    if (this.current) return this.current;
    if (!this.blocker()) { this.blockedActivity = null; return null; }
    this.blockedActivity ||= { id: randomUUID(), label: "运行状态未确认，请先核对成果记录", stopping: true, recoveryRequired: true };
    return this.blockedActivity;
  }

  setBlocker(blocker) { this.blocker = blocker; }

  acquire(label) {
    if (this.active) throw new WorkspaceBusyError();
    return this.own(label);
  }

  own(label) {
    let settle;
    const token = { id: randomUUID(), label, stopping: false, settled: false, done: new Promise((resolve) => { settle = resolve; }) };
    this.current = token;
    return { token, release: () => {
      token.settled = true;
      settle();
      if (this.current === token && !token.recoveryRequired) this.current = null;
    } };
  }

  retain(token = this.current) {
    if (token) token.recoveryRequired = true;
  }

  async run(label, operation, owner = null) {
    if (owner) {
      if (owner !== this.current || owner.settled || owner.recoveryRequired) throw new WorkspaceBusyError();
      return operation(owner);
    }
    const { token, release } = this.acquire(label);
    try { return await operation(token); } finally { release(); }
  }

  async recover(operation) {
    const previous = this.current;
    if (previous && !previous.recoveryRequired) throw new WorkspaceBusyError();
    const { token, release } = this.own("核对并恢复运行时");
    try { return await operation(previous); }
    catch (error) { this.retain(token); throw error; }
    finally { release(); }
  }

  assertIdle() { if (this.active) throw new WorkspaceBusyError(); }
}
