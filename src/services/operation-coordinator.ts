import { AppError } from '../errors.js';

export class OperationCoordinator {
  private accepting = true;
  private readonly active = new Set<Promise<unknown>>();
  private idleWaiters: Array<() => void> = [];

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new AppError('L’applicazione si sta arrestando e non accetta nuove operazioni.', 503, 'ARRESTO_IN_CORSO'));
    const work = Promise.resolve().then(operation);
    this.active.add(work);
    void work.finally(() => {
      this.active.delete(work);
      if (this.active.size === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }).catch(() => undefined);
    return work;
  }

  stopAccepting(): void { this.accepting = false; }
  resume(): void { this.accepting = true; }
  get isAccepting(): boolean { return this.accepting; }
  get activeCount(): number { return this.active.size; }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!this.active.size) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      this.idleWaiters.push(onIdle);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref();
    });
  }

  async whenIdle(): Promise<void> {
    if (!this.active.size) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
}
