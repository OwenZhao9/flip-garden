// A coarse, global fixed-window limiter kept in the isolate's memory. It stores no IP address and nothing is persisted:
// it only protects the RPC and KV budget from a flood. Cloudflare's own rate limiting rules (dashboard) are the real
// per-client defence; see server/README.md.
export class Limiter {
  private windowStart = 0;
  private count = 0;
  readonly max: number;
  readonly windowMs: number;
  constructor(max: number, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  allow(now: number): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    return this.count <= this.max;
  }
}
