export type DocumentSessionOperation = {
  epoch: number;
  signal: AbortSignal;
};

export class DocumentSessionScope {
  private epoch = 0;
  private controller = new AbortController();

  advance(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.epoch += 1;
  }

  capture(): DocumentSessionOperation {
    return {
      epoch: this.epoch,
      signal: this.controller.signal
    };
  }

  isCurrent(operation: DocumentSessionOperation): boolean {
    return (
      !operation.signal.aborted &&
      operation.epoch === this.epoch &&
      operation.signal === this.controller.signal
    );
  }

  dispose(): void {
    this.controller.abort();
  }
}
