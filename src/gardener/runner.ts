// The Gardener's loop: one check at a time, never two at once. Each check reads the chain, applies the stop conditions,
// asks the questions the policy allows, routes each answer by confidence (act, ask the user, or do nothing) and carries
// out at most one intent. It works only while the page runs it (the page stops it when the tab is hidden or the passkey
// session locks), and Stop halts it at once: no further transaction is offered after Stop is pressed.
import type { Announcement } from '../flow.ts';
import type { Decider } from './decide.ts';
import { execute, type ExecCtx, type Outcome } from './execute.ts';
import { remaining, failuresSince, type Mandate, type Remaining, type Spend, type SpendEvent } from './mandate.ts';
import { afterAction, describe, freshMemory, intentOf, needsRefuel, questions, remember, route, stopCheck, POLICY, type Answer, type Choice, type Intent, type Memory, type Observation, type Question, type QuestionId } from './policy.ts';

export type Status = 'watching' | 'acting' | 'asking' | 'waiting' | 'stopped';
export const STATUS_TEXT: Record<Status, string> = { watching: 'Watching', acting: 'Acting', asking: 'Waiting for you', waiting: 'Waiting', stopped: 'Stopped' };

export type TimelineTx = { kind: string; status: string; hash?: string; feeWei: string; facts: string[]; problems: string[] };
export type TimelineEntry = {
  atMs: number;
  block: number;
  question: QuestionId | 'refuel' | 'stop';
  choice?: string;
  confidence?: number;
  source?: 'rules' | 'jev';
  route?: 'act' | 'ask' | 'skip';
  action?: string;
  reason: string;
  outcome: string;
  ok?: boolean;
  txs: TimelineTx[];
};

export type GardenerDeps = {
  mandate: Mandate;
  decider: Decider;
  observe: () => Promise<Observation>;
  exec: Omit<ExecCtx, 'mandate' | 'spend' | 'record' | 'now' | 'confirm' | 'stopped'>;
  now?: () => number;
  // A choice between the two confidence thresholds: show the suggestion and resolve true if the user wants it carried
  // out. Each of its transactions is then confirmed on the normal card (`confirmTx`).
  ask: (q: Question, a: Answer, action: string) => Promise<boolean>;
  confirmTx: (a: Announcement, text: string) => Promise<boolean>;
  onChange?: () => void;
  onEntry?: (e: TimelineEntry) => void;
  checkSeconds?: number;
  executeImpl?: typeof execute; // tests
};

const txOf = (o: Outcome): TimelineTx[] => o.txs.map((t) => ({ kind: t.kind, status: t.status, hash: t.hash, feeWei: t.feeWei.toString(), facts: t.facts, problems: t.problems }));

export class Gardener {
  status: Status = 'watching';
  note = 'Starting.';
  spend: Spend = [];
  mem: Memory = freshMemory();
  timeline: TimelineEntry[] = [];
  lastObs: Observation | null = null;
  private busy = false;
  private stopped = false;
  private lastQuiet = new Map<string, string>(); // question key -> last "do nothing" choice, so a repeated keep is logged once
  private readonly now: () => number;
  private readonly d: GardenerDeps;

  constructor(d: GardenerDeps) {
    this.d = d;
    this.now = d.now ?? (() => Date.now());
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  remaining(): Remaining {
    return remaining(this.d.mandate, this.spend, this.now());
  }

  private set(status: Status, note: string): void {
    this.status = status;
    this.note = note;
    this.d.onChange?.();
  }

  private log(e: Omit<TimelineEntry, 'atMs' | 'block'>): void {
    const entry = { atMs: this.now(), block: this.lastObs?.block ?? 0, ...e };
    this.timeline.unshift(entry);
    this.d.onEntry?.(entry);
  }

  stop(reason = 'Stopped by you.'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.set('stopped', reason);
    this.log({ question: 'stop', reason, outcome: 'No further transaction will be offered.', txs: [] });
  }

  // One check. Returns without doing anything while another check is still running.
  async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      await this.check();
    } catch (e) {
      if (!this.stopped) this.set('waiting', `The check could not finish (${(e as Error).message}). Trying again at the next check.`);
    } finally {
      this.busy = false;
    }
  }

  private async check(): Promise<void> {
    const m = this.d.mandate;
    let obs: Observation;
    try {
      obs = await this.d.observe();
    } catch (e) {
      return this.set('waiting', `The chain could not be read (${(e as Error).message}). Trying again at the next check.`);
    }
    if (this.stopped) return;
    const now = this.now();
    this.lastObs = obs;
    this.mem = remember(this.mem, obs, now);
    const stop = stopCheck(obs, m, this.spend, this.mem, now);
    if (stop) return stop.final ? this.stop(stop.text) : this.set('waiting', stop.text);

    if (needsRefuel(obs, m, this.spend, this.mem, now)) {
      return this.carryOut({ id: 'harvest', options: ['harvest'], rulesChoice: 'harvest', facts: {}, why: 'The wallet is low on MON for network fees and MON is free at Kuru.' }, { choice: 'refuel', confidence: 1, source: 'rules' }, { type: 'refuel', kind: 'refuel' }, 'act', obs, 'refuel');
    }

    const qs = questions(obs, m, this.spend, this.mem, now);
    if (!qs.length) return this.set('watching', 'Everything is inside the mandate. Nothing to do.');
    const answers = await this.d.decider.decide(qs, { obs, mandate: m, failures: failuresSince(this.spend, now - POLICY.failureWindowMs), checkSeconds: this.d.checkSeconds ?? 5 });
    if (this.stopped) return;

    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const a = answers[i] ?? null;
      const r = route(q, a, m);
      const key = `${q.id}:${q.facts.orderId ?? ''}`;
      if (r === 'skip') {
        const why = a ? `Confidence ${a.confidence.toFixed(2)} is below ${m.askAt}.` : 'No valid answer in time (Jev unreachable, slow or malformed).';
        this.quiet(key, `skip:${a?.choice ?? 'none'}`, { question: q.id, choice: a?.choice, confidence: a?.confidence, source: a?.source ?? this.d.decider.name, route: 'skip', reason: q.why, outcome: `Did nothing. ${why}`, txs: [] });
        continue;
      }
      const intent = intentOf(q, a!.choice as Choice, obs, m);
      if (!intent) {
        this.quiet(key, a!.choice, { question: q.id, choice: a!.choice, confidence: a!.confidence, source: a!.source, route: r, reason: q.why, outcome: 'Chose to leave things as they are.', txs: [] });
        continue;
      }
      this.lastQuiet.delete(key);
      return this.carryOut(q, a!, intent, r, obs);
    }
    this.set('watching', 'Checked; nothing to carry out.');
  }

  private quiet(key: string, sig: string, e: Omit<TimelineEntry, 'atMs' | 'block'>): void {
    if (this.lastQuiet.get(key) !== sig) this.log(e);
    this.lastQuiet.set(key, sig);
  }

  private async carryOut(q: Question, a: Answer, intent: Intent, r: 'act' | 'ask', obs: Observation, label?: 'refuel'): Promise<void> {
    const m = this.d.mandate;
    const action = describe(intent);
    const base = { question: label ?? q.id, choice: a.choice, confidence: a.confidence, source: a.source, route: r, action, reason: q.why } as const;
    if (r === 'ask') {
      this.set('asking', `Suggestion: ${action}`);
      const go = await this.d.ask(q, a, action);
      if (this.stopped) return;
      if (!go) {
        this.mem = afterAction(this.mem, intent.kind, false, this.now()); // do not ask again at once
        this.log({ ...base, outcome: 'You declined the suggestion. Nothing was sent.', txs: [] });
        return this.set('watching', 'Suggestion declined.');
      }
    }
    this.set('acting', action);
    const ctx: ExecCtx = {
      ...this.d.exec,
      mandate: m,
      spend: () => this.spend,
      record: (e: SpendEvent) => void this.spend.push(e),
      now: this.now,
      confirm: r === 'act' ? async () => !this.stopped : (ann, text) => (this.stopped ? Promise.resolve(false) : this.d.confirmTx(ann, text)),
      stopped: () => this.stopped,
    };
    const outcome = await (this.d.executeImpl ?? execute)(ctx, intent, obs);
    this.mem = afterAction(this.mem, intent.kind, outcome.ok, this.now());
    this.log({ ...base, outcome: outcome.text, ok: outcome.ok, txs: txOf(outcome) });
    if (outcome.cannotExplain) return this.stop(`Stopped: ${outcome.text}`);
    if (this.stopped) return;
    this.set('watching', outcome.text);
  }
}
