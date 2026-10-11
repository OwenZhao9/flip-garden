// Live refresh: run `run` every `everyMs` while the tab is visible, pause while it is hidden, never overlap two runs,
// and catch up at once when the tab comes back after a pause. Each run reuses the scanner's cache (pipeline.ts reads
// only the blocks that are new), so a tick costs a handful of requests, not a full scan.
export type LiveOpts = {
  run(): Promise<void>;
  everyMs: number;
  canRun?(): boolean; // false = skip this tick (an action is in progress)
  doc?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  now?(): number;
};

export function startLive(o: LiveOpts): () => void {
  const doc = o.doc ?? document;
  const now = o.now ?? Date.now;
  let stopped = false;
  let inflight = false;
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (!stopped) timer = setTimeout(() => void tick(), o.everyMs);
  };
  const tick = async (): Promise<void> => {
    clearTimeout(timer);
    if (stopped) return;
    if (doc.hidden || inflight || (o.canRun && !o.canRun())) return schedule();
    inflight = true;
    try {
      await o.run();
    } catch {
      // the caller reports its own errors; the loop keeps going
    } finally {
      inflight = false;
      lastRun = now();
      schedule();
    }
  };
  const onVisible = (): void => {
    if (!doc.hidden && !stopped && !inflight && now() - lastRun >= o.everyMs) void tick();
  };
  doc.addEventListener('visibilitychange', onVisible);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    doc.removeEventListener('visibilitychange', onVisible);
  };
}
