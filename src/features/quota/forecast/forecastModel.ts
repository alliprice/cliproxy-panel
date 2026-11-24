/**
 * Provider-wide quota forecast: recorded history, drain rate and a projection.
 *
 * Works on one window (weekly or 5-hour) of each credential. Capacity is N x 100%.
 * The drain rate comes from recorded history when there is enough of it, and
 * from the serving accounts' rates otherwise, so it works on the first load. The
 * projection refills each credential at its known reset, which gives the
 * sawtooth. Pure: `nowMs` is always passed in.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { QuotaSnapshot } from './quotaHistory';
import { nextResetAfter } from './quotaMeters';

/**
 * Two readings further apart than this are a gap, never interpolated: the
 * drain chart breaks there, and the history line holds and then steps.
 */
export const HISTORY_GAP_MS = 3 * HOUR_MS;

const PROJECTION_STEP_MS = 10 * MINUTE_MS;
/** Credentials resetting this close together count as one reset event. */
const RESET_GROUP_MS = MINUTE_MS;
/** Percent points under which a simulated credential counts as empty. */
const EMPTY_EPSILON = 1e-6;

export interface ChartPoint {
  t: number;
  v: number;
}

export interface LiveReading {
  credentialId: string;
  remaining: number;
  resetAtMs: number | null;
  periodHours: number | null;
  /**
   * Rate used for this account: the faster of its window average and its
   * measured rate. A window that ran out keeps the pace it had until it hit 0.
   */
  ratePerHour: number | null;
  /** The window's own average since it opened (the dotted reference line). */
  averagePerHour: number | null;
  /**
   * Set while CLIProxyAPI benches the account in a cooldown: it counts toward
   * capacity but holds 0% (`remaining` is 0) and takes no drain until it is
   * back. Its rate counts toward the provider drain only when every account is
   * cooling and there is too little history (see currentDrain). `resetAtMs` is then
   * the window's reset as last read, which may have passed during the cooldown.
   */
  cooldown?: AccountCooldown;
}

export interface AccountCooldown {
  /**
   * When the cooldown ends. Null when unknown: the account then stays out until
   * its window resets if a reset is known ahead, and for the whole range if not.
   */
  untilMs: number | null;
  /**
   * What the account holds when it comes back: its last reading. A window whose
   * reset is at or before the return time (or before now) refills to 100% instead.
   */
  returnRemaining: number;
}

/** Where the provider drain rate comes from. */
export type DrainSource = 'history' | 'window';

export interface ProviderDrain {
  /**
   * Rate used for the projection, percent points per hour: the recent pace
   * from recorded history, else the serving accounts' rates (see currentDrain).
   */
  ratePerHour: number;
  source: DrainSource;
  /** Recorded history inside the lookback that backs a measured rate. */
  coveredMs: number;
  /** Sum of each window's average since it opened (until it ran out): the reference. */
  windowAverage: number;
}

export interface ResetEvent {
  atMs: number;
  /** Capacity given back, in percent points. */
  gain: number;
}

export interface QuotaForecast {
  capacity: number;
  remaining: number;
  /** Percent points per hour across the provider, with where it comes from. */
  drain: ProviderDrain;
  history: ChartPoint[][];
  projection: ChartPoint[];
  nextReset: ResetEvent | null;
  /** When the whole provider hits 0% inside the range, if it does. */
  allOutAtMs: number | null;
  /** First time an account that has quota now reaches 0% in the projection. */
  firstRunsOutAtMs: number | null;
  /** Accounts at 0% right now (cooling ones included), and when the first is back. */
  outNow: { count: number; backAtMs: number | null };
  /** Percent still unspent across accounts just before their first reset in the range. */
  unusedAtResets: number;
  /** Per-account detail behind `unusedAtResets`, soonest reset first. */
  unusedByAccount: { credentialId: string; unused: number; resetAtMs: number }[];
  /** Distinct recorded readings in the loaded history. */
  readings: number;
  /**
   * The same projection at the window-average pace, to compare the recent pace
   * with the longer pattern. Null unless comparesWindowAverage.
   */
  atWindowAverage: WindowAverageProjection | null;
}

export interface WindowAverageProjection {
  /** The drain it runs at: ProviderDrain.windowAverage. */
  ratePerHour: number;
  projection: ChartPoint[];
  firstRunsOutAtMs: number | null;
  allOutAtMs: number | null;
}

export interface ForecastInput {
  live: LiveReading[];
  history: QuotaSnapshot[];
  nowMs: number;
  /** Forward horizon of the projection. */
  rangeMs: number;
  /** Window the drain rate is measured over. */
  lookbackMs: number;
  /** Recorded coverage needed before the measured rate replaces the average. */
  enoughMs: number;
}

const byCredential = (history: QuotaSnapshot[]) => {
  const groups = new Map<string, QuotaSnapshot[]>();
  history.forEach((snapshot) => {
    const group = groups.get(snapshot.credentialId) ?? [];
    group.push(snapshot);
    groups.set(snapshot.credentialId, group);
  });
  groups.forEach((group) => group.sort((a, b) => a.ts - b.ts));
  return groups;
};

/** Value a snapshot implies at `t`: a passed reset means the window refilled. */
const valueAt = (snapshot: QuotaSnapshot, t: number) =>
  snapshot.resetAtMs !== null && snapshot.resetAtMs <= t ? 100 : snapshot.remaining;

const toMinute = (ts: number) => Math.round(ts / MINUTE_MS) * MINUTE_MS;

/**
 * The provider total over recorded time: at each recorded instant, the sum of
 * the latest reading of every credential in `credentialIds`, however old.
 * An account that serves no traffic gets no new reading, and its quota does
 * not change through the proxy while it is idle, so its last reading holds
 * (a reset that passed counts as a refill, at the reset time).
 *
 * The line starts once every credential has a reading and runs to `untilMs`
 * (now). Readings and resets are bucketed to the minute; inside one minute a
 * reset counts before a reading. A reset is a step. Readings further apart
 * than HISTORY_GAP_MS are not interpolated: the total holds, then steps at the
 * next reading.
 */
export function aggregateHistory(
  history: QuotaSnapshot[],
  credentialIds: ReadonlySet<string>,
  untilMs: number
): ChartPoint[][] {
  const groups = byCredential(
    history.filter((snapshot) => credentialIds.has(snapshot.credentialId) && snapshot.ts <= untilMs)
  );
  if (groups.size === 0) return [];
  const startMs = Math.max(...Array.from(groups.values(), (group) => toMinute(group[0].ts)));

  const readingInstants = new Set<number>();
  groups.forEach((group) =>
    group.forEach((snapshot) => {
      const t = toMinute(snapshot.ts);
      if (t >= startMs) readingInstants.add(t);
    })
  );

  // A reset counts where it happened while its reading was still the latest.
  const resets = new Set<number>();
  groups.forEach((group) =>
    group.forEach((snapshot, index) => {
      const reset = snapshot.resetAtMs;
      const next = group[index + 1];
      if (reset === null || reset <= snapshot.ts || (next && reset >= next.ts)) return;
      if (reset <= untilMs && toMinute(reset) > startMs) resets.add(toMinute(reset));
    })
  );

  const instants = Array.from(new Set([...readingInstants, ...resets])).sort((a, b) => a - b);
  const cursors = new Map<string, number>();
  const points: ChartPoint[] = [];
  let lastReadingMs: number | null = null;
  instants.forEach((t) => {
    // Everything toMinute puts in t's minute, [t - 30s, t + 30s), and nothing
    // after untilMs, counts at t.
    const edge = Math.min(t + MINUTE_MS / 2, untilMs + 1);
    let sum = 0;
    groups.forEach((group, credentialId) => {
      let index = cursors.get(credentialId) ?? -1;
      while (index + 1 < group.length && group[index + 1].ts < edge) index += 1;
      cursors.set(credentialId, index);
      const snapshot = group[index];
      if (snapshot) sum += valueAt(snapshot, edge - 1);
    });
    const isReading = readingInstants.has(t);
    const silence = isReading && lastReadingMs !== null && t - lastReadingMs > HISTORY_GAP_MS;
    const previous = points[points.length - 1];
    if (previous && (resets.has(t) || silence)) points.push({ t: t - 1, v: previous.v });
    points.push({ t, v: sum });
    if (isReading) lastReadingMs = t;
  });
  const last = points[points.length - 1];
  if (last && untilMs > last.t) points.push({ t: untilMs, v: last.v });
  return [points];
}

/**
 * The part of a line inside [startMs, endMs]. A line that crosses an edge gets
 * a point on that edge, interpolated between its neighbours, so a hold that
 * started before the visible range still shows inside it.
 */
export function clipToRange(points: ChartPoint[], startMs: number, endMs: number): ChartPoint[] {
  const between = (a: ChartPoint, b: ChartPoint, t: number): ChartPoint => ({
    t,
    v: a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t),
  });
  const clipped: ChartPoint[] = [];
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (previous && previous.t < startMs && point.t > startMs) {
      clipped.push(between(previous, point, startMs));
    }
    if (point.t >= startMs && point.t <= endMs) clipped.push(point);
    if (previous && previous.t < endMs && point.t > endMs) {
      clipped.push(between(previous, point, endMs));
    }
  });
  return clipped;
}

/** Two readings belong to one run: close enough in time and no reset between. */
const sameRun = (a: QuotaSnapshot, b: QuotaSnapshot) =>
  b.ts - a.ts <= HISTORY_GAP_MS && (a.resetAtMs === null || a.resetAtMs > b.ts);

interface DrainMeasurement {
  ratePerHour: number;
  coveredMs: number;
}

/**
 * Consumption in [fromMs, toMs] from recorded history.
 *
 * Usage values are coarse (Anthropic reports whole percent), so most
 * consecutive readings are equal and the drop shows up as a rare 1% step.
 * Each credential's readings are split into gap-free runs (no silence over
 * HISTORY_GAP_MS, no reset); a run contributes first - last over its span, so
 * a period with any drop never reads as 0. A run that starts before `fromMs`
 * is cut there: its first interval is prorated, so the consumption and the
 * covered time clip alike. The rate is the total consumed over
 * the union of the runs' spans. Null when less than `minCoveredMs` is covered.
 * Expects one window per credential (the caller filters by window).
 */
export function measureDrain(
  history: QuotaSnapshot[],
  fromMs: number,
  toMs: number,
  minCoveredMs = 30 * MINUTE_MS
): DrainMeasurement | null {
  let consumed = 0;
  const spans: [number, number][] = [];

  byCredential(history).forEach((group) => {
    // The last reading before `fromMs` anchors a run that started earlier.
    const firstInside = group.findIndex((snapshot) => snapshot.ts >= fromMs);
    if (firstInside === -1) return;
    const inRange = group
      .slice(Math.max(0, firstInside - 1))
      .filter((snapshot) => snapshot.ts <= toMs);

    let runStart = 0;
    for (let index = 1; index <= inRange.length; index += 1) {
      const ended = index === inRange.length || !sameRun(inRange[index - 1], inRange[index]);
      if (!ended) continue;
      const first = inRange[runStart];
      const last = inRange[index - 1];
      const spanStart = Math.max(first.ts, fromMs);
      const spanEnd = Math.min(last.ts, toMs);
      if (spanEnd > spanStart) {
        // The run may start before `fromMs`: only the part of its first
        // interval that lies inside the range counts, as it does for the time.
        let startValue = first.remaining;
        if (first.ts < fromMs) {
          const next = inRange[runStart + 1];
          startValue +=
            ((next.remaining - first.remaining) * (fromMs - first.ts)) / (next.ts - first.ts);
        }
        consumed += Math.max(0, startValue - last.remaining);
        spans.push([spanStart, spanEnd]);
      }
      runStart = index;
    }
  });

  spans.sort((a, b) => a[0] - b[0]);
  let coveredMs = 0;
  let end = -Infinity;
  spans.forEach(([start, stop]) => {
    if (stop <= end) return;
    coveredMs += stop - Math.max(start, end);
    end = stop;
  });
  if (coveredMs < minCoveredMs) return null;
  return { ratePerHour: consumed / (coveredMs / HOUR_MS), coveredMs };
}

/** Drain buckets across the shown span: enough for a line, not so many it turns to noise. */
const DRAIN_BUCKETS = 36;
const MIN_DRAIN_BUCKET_MS = 10 * MINUTE_MS;
/** Each point averages this many buckets back, so 1% steps read as a rate, not spikes. */
const DRAIN_SMOOTHING_BUCKETS = 3;
/** The drain chart spans at least this much, even with a few minutes of readings. */
const MIN_DRAIN_SPAN_MS = HOUR_MS;

export interface DrainSeries {
  /** Left edge of the chart; the right edge is now. */
  startMs: number;
  segments: ChartPoint[][];
}

/**
 * Measured drain over the past, for the "Drain rate" chart. It covers the
 * recorded readings (at most `rangeMs` back), sampled every span/36 (at least
 * 10 min); each point is the trailing average over three samples. Points join
 * inside a run of readings; a silence over HISTORY_GAP_MS starts a new line.
 */
export function drainSeries(history: QuotaSnapshot[], nowMs: number, rangeMs: number): DrainSeries {
  const earliestMs = history.reduce((earliest, snapshot) => Math.min(earliest, snapshot.ts), nowMs);
  const startMs = Math.max(nowMs - rangeMs, Math.min(earliestMs, nowMs - MIN_DRAIN_SPAN_MS));
  const bucketMs = Math.max(MIN_DRAIN_BUCKET_MS, (nowMs - startMs) / DRAIN_BUCKETS);
  const windowMs = bucketMs * DRAIN_SMOOTHING_BUCKETS;

  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (let t = startMs + bucketMs; t < nowMs + bucketMs; t += bucketMs) {
    const at = Math.min(t, nowMs);
    const measured = measureDrain(history, at - windowMs, at, windowMs / 6);
    if (measured === null) continue;
    const last = current[current.length - 1];
    if (last && at - last.t > HISTORY_GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push({ t: at, v: measured.ratePerHour });
  }
  if (current.length > 0) segments.push(current);
  return { startMs, segments };
}

/**
 * Current provider drain. The fresher data controls: the pace measured over
 * all accounts' recorded readings across the lookback, once they cover
 * `enoughMs`. That measurement includes an account that ran out, up to the
 * moment it did, so the pace does not drop when the traffic moves to another
 * account. With too little history it is the sum of the rates of the accounts
 * not cooling (of every account, when all are cooling): a cooling account's
 * old pace is the traffic the serving account now carries, not more of it.
 */
export function currentDrain(
  live: LiveReading[],
  history: QuotaSnapshot[],
  nowMs: number,
  lookbackMs: number,
  enoughMs: number
): ProviderDrain {
  const measured = measureDrain(history, nowMs - lookbackMs, nowMs);
  const windowAverage = live.reduce((total, reading) => total + (reading.averagePerHour ?? 0), 0);
  if (measured && measured.coveredMs >= enoughMs) {
    return {
      ratePerHour: measured.ratePerHour,
      source: 'history',
      coveredMs: measured.coveredMs,
      windowAverage,
    };
  }
  const serving = live.filter((reading) => !reading.cooldown);
  return {
    ratePerHour: (serving.length > 0 ? serving : live).reduce(
      (total, reading) => total + (reading.ratePerHour ?? 0),
      0
    ),
    source: 'window',
    coveredMs: measured?.coveredMs ?? 0,
    windowAverage,
  };
}

/**
 * When a cooling account is back: the end of its cooldown, else its window's
 * next reset when one is known ahead, else never (null). Null for a serving
 * account. A 5-hour window whose reset has passed has no known reset ahead.
 */
export function cooldownReturnMs(reading: LiveReading, nowMs: number): number | null {
  if (!reading.cooldown) return null;
  if (reading.cooldown.untilMs !== null) return reading.cooldown.untilMs;
  if (reading.resetAtMs === null) return null;
  return nextResetAfter(reading.resetAtMs, reading.periodHours, nowMs);
}

/** Facts the projection records for the outlook, so the two always agree. */
export interface ProjectionTrace {
  /** First time an account that had quota at `nowMs` reached 0%. */
  firstEmptyAtMs: number | null;
  /** First time every account is empty at once: nothing is left to serve. */
  allEmptyAtMs: number | null;
  /**
   * Remaining just before each account's first window reset ahead in the range.
   * An account still benched at that reset holds 0%, so it counts as 0 unused.
   */
  beforeFirstReset: { credentialId: string; unused: number; resetAtMs: number }[];
}

/**
 * Outlook per account. Out-now counts the accounts at 0% (a cooling one is back
 * at its return time); the first run-out and the unused quota come from the
 * projection's trace, so they follow the same drain split as the chart.
 */
export function accountOutlook(
  live: LiveReading[],
  nowMs: number,
  trace: ProjectionTrace
): Pick<QuotaForecast, 'firstRunsOutAtMs' | 'outNow' | 'unusedAtResets' | 'unusedByAccount'> {
  const outNow: QuotaForecast['outNow'] = { count: 0, backAtMs: null };
  live.forEach((reading) => {
    if (reading.remaining > 0) return;
    outNow.count += 1;
    const backAtMs = reading.cooldown ? cooldownReturnMs(reading, nowMs) : reading.resetAtMs;
    if (backAtMs !== null && backAtMs > nowMs) {
      outNow.backAtMs = Math.min(outNow.backAtMs ?? Infinity, backAtMs);
    }
  });
  const unusedByAccount = [...trace.beforeFirstReset].sort((a, b) => a.resetAtMs - b.resetAtMs);
  return {
    firstRunsOutAtMs: trace.firstEmptyAtMs,
    outNow,
    unusedAtResets: unusedByAccount.reduce((total, item) => total + item.unused, 0),
    unusedByAccount,
  };
}

/**
 * One account inside the projection. Times are milliseconds elapsed since the
 * projection's `nowMs`: small numbers keep the precision that an epoch
 * timestamp loses, so a step a fraction of a millisecond long is not rounded away.
 */
interface SimulatedCredential {
  credentialId: string;
  remaining: number;
  ratePerHour: number | null;
  periodHours: number | null;
  resetAt: number | null;
  /** Benched: takes no drain and does not reset until `returnAt`. */
  out: boolean;
  returnAt: number | null;
  returnRemaining: number;
  /** Its window reset while it was benched: it comes back at 100%. */
  refilled: boolean;
  /** Had quota at the start: only these count toward the first run-out. */
  hadQuota: boolean;
  /** Its first window reset ahead is in the trace. */
  recordedReset: boolean;
}

/**
 * Sawtooth projection from `nowMs`. The provider keeps falling at
 * `drainPerHour` while any account has quota. At each moment the drain is split
 * among the accounts that have quota and are not benched, in proportion to
 * their rate (evenly when none has one). A step ends early when an account
 * empties, resets or comes back from a cooldown, so no drain is lost. A reset
 * refills an account to 100% and a cooldown's end returns it with what it held
 * (or 100% when its window reset by then); either counts as a reset event. A
 * serving account with no known reset and a window shorter than a day starts
 * that window when it first receives drain and resets a period later.
 *
 * An account emptying is an event of its own: every account due to empty by the
 * end of a step is set to exactly 0, whatever the subtraction would leave. A
 * step therefore either moves time forward or empties an account, so the loop
 * always ends.
 */
export function projectQuota(
  live: LiveReading[],
  drainPerHour: number,
  nowMs: number,
  untilMs: number
): { points: ChartPoint[]; resets: ResetEvent[]; trace: ProjectionTrace } {
  const elapsed = (atMs: number | null) => (atMs === null ? null : atMs - nowMs);
  const credentials: SimulatedCredential[] = live.map((reading) => {
    // A cooling account's window may have reset before now: it comes back to a
    // full window, on the same schedule a reset inside the range follows.
    const resetBehind =
      reading.cooldown !== undefined && reading.resetAtMs !== null && reading.resetAtMs <= nowMs;
    return {
      credentialId: reading.credentialId,
      remaining: reading.remaining,
      ratePerHour: reading.ratePerHour,
      periodHours: reading.periodHours,
      resetAt: elapsed(
        resetBehind
          ? nextResetAfter(reading.resetAtMs as number, reading.periodHours, nowMs)
          : reading.resetAtMs
      ),
      out: reading.cooldown !== undefined,
      returnAt: elapsed(cooldownReturnMs(reading, nowMs)),
      returnRemaining: reading.cooldown?.returnRemaining ?? 0,
      refilled: resetBehind,
      hadQuota: reading.remaining > 0,
      recordedReset: false,
    };
  });
  const horizon = untilMs - nowMs;
  /** The reset after a refill at `at` when the account was in use: a period later. */
  const periodAfter = (item: SimulatedCredential, at: number) =>
    item.periodHours ? at + item.periodHours * HOUR_MS : null;
  const sum = () => credentials.reduce((total, item) => total + item.remaining, 0);
  const points: ChartPoint[] = [{ t: nowMs, v: sum() }];
  const resets: ResetEvent[] = [];
  const trace: ProjectionTrace = { firstEmptyAtMs: null, allEmptyAtMs: null, beforeFirstReset: [] };

  let at = 0;
  while (at < horizon) {
    const active = credentials.filter((item) => !item.out && item.remaining > 0);
    const rateTotal = active.reduce((total, item) => total + (item.ratePerHour ?? 0), 0);
    const perMs = new Map<SimulatedCredential, number>(
      active.map((item) => [
        item,
        (rateTotal > 0
          ? ((item.ratePerHour ?? 0) / rateTotal) * drainPerHour
          : drainPerHour / active.length) / HOUR_MS,
      ])
    );

    // A window shorter than a day whose reset has passed starts again with its
    // next request: for an account with no known reset, the first drain it
    // receives starts the window, which resets a period later.
    perMs.forEach((rate, item) => {
      if (
        rate > 0 &&
        item.resetAt === null &&
        item.periodHours &&
        item.periodHours * HOUR_MS < DAY_MS
      ) {
        item.resetAt = periodAfter(item, at);
      }
    });

    // The step ends at the soonest of: its normal length, a window reset (a
    // benched account's too), a return from a cooldown, or an active account
    // emptying.
    let next = Math.min(at + PROJECTION_STEP_MS, horizon);
    credentials.forEach((item) => {
      [item.resetAt, item.out ? item.returnAt : null].forEach((eventAt) => {
        if (eventAt !== null && eventAt > at && eventAt < next) next = eventAt;
      });
    });
    const emptyAt = new Map<SimulatedCredential, number>();
    perMs.forEach((rate, item) => {
      if (rate <= 0) return;
      const when = at + item.remaining / rate;
      emptyAt.set(item, when);
      if (when < next) next = when;
    });

    active.forEach((item) => {
      const empties = (emptyAt.get(item) ?? Infinity) <= next;
      item.remaining = empties
        ? 0
        : Math.max(0, item.remaining - (perMs.get(item) ?? 0) * (next - at));
      if (item.remaining > EMPTY_EPSILON) return;
      item.remaining = 0;
      if (item.hadQuota && trace.firstEmptyAtMs === null) trace.firstEmptyAtMs = nowMs + next;
    });
    at = next;
    points.push({ t: nowMs + at, v: sum() });
    // An emptied account holds exactly 0, so "all empty" is exact, not a threshold.
    if (trace.allEmptyAtMs === null && credentials.every((item) => item.remaining === 0)) {
      trace.allEmptyAtMs = nowMs + at;
    }

    const resetting = credentials.filter((item) => item.resetAt === at);
    const returning = credentials.filter((item) => item.out && item.returnAt === at);
    const refills = returning.length > 0 || resetting.some((item) => !item.out);

    let gain = 0;
    resetting.forEach((item) => {
      // What the window discards: a benched account holds 0%, so it loses nothing.
      if (!item.recordedReset) {
        trace.beforeFirstReset.push({
          credentialId: item.credentialId,
          unused: item.remaining,
          resetAtMs: nowMs + at,
        });
        item.recordedReset = true;
      }
      if (item.out) {
        // Benched through its reset: the account comes back to a full window. A
        // cooldown does not move a window of a day or longer off its schedule;
        // a 5-hour one starts again on the next request, after the return.
        item.refilled = true;
        item.resetAt = nextResetAfter(item.resetAt as number, item.periodHours, at);
        return;
      }
      gain += 100 - item.remaining;
      item.remaining = 100;
      item.resetAt = periodAfter(item, at);
    });
    returning.forEach((item) => {
      item.out = false;
      item.remaining = item.refilled ? 100 : item.returnRemaining;
      // A 5-hour window starts again with the requests it takes from its return.
      if (item.refilled && item.resetAt === null) item.resetAt = periodAfter(item, at);
      gain += item.remaining;
    });
    if (!refills) continue;
    const last = resets[resets.length - 1];
    if (last && nowMs + at - last.atMs <= RESET_GROUP_MS) last.gain += gain;
    else resets.push({ atMs: nowMs + at, gain });
    points.push({ t: nowMs + at, v: sum() });
  }
  return { points, resets, trace };
}

/** The two paces read as one line when they differ by no more than this share. */
const PACE_DIFFERENCE = 0.05;

/**
 * Whether the projection at the window-average pace is worth showing next to
 * the main one: the main drain is the recent pace measured from history, some
 * window has a known average, and the two rates differ by more than 5% of the
 * larger. Otherwise the two lines coincide, or the main one already follows
 * the windows' own rates.
 */
export function comparesWindowAverage(drain: ProviderDrain, live: LiveReading[]): boolean {
  if (drain.source !== 'history') return false;
  if (!live.some((reading) => reading.averagePerHour !== null)) return false;
  const larger = Math.max(drain.ratePerHour, drain.windowAverage);
  return Math.abs(drain.ratePerHour - drain.windowAverage) > PACE_DIFFERENCE * larger;
}

export function buildQuotaForecast(input: ForecastInput): QuotaForecast {
  const { live, history, nowMs, rangeMs, lookbackMs, enoughMs } = input;
  const drain = currentDrain(live, history, nowMs, lookbackMs, enoughMs);
  const { points, resets, trace } = projectQuota(live, drain.ratePerHour, nowMs, nowMs + rangeMs);
  const outlook = accountOutlook(live, nowMs, trace);
  let atWindowAverage: WindowAverageProjection | null = null;
  if (comparesWindowAverage(drain, live)) {
    const average = projectQuota(live, drain.windowAverage, nowMs, nowMs + rangeMs);
    atWindowAverage = {
      ratePerHour: drain.windowAverage,
      projection: average.points,
      firstRunsOutAtMs: average.trace.firstEmptyAtMs,
      allOutAtMs: average.trace.allEmptyAtMs,
    };
  }
  return {
    capacity: live.length * 100,
    remaining: live.reduce((total, reading) => total + reading.remaining, 0),
    drain,
    history: aggregateHistory(history, new Set(live.map((reading) => reading.credentialId)), nowMs),
    readings: new Set(history.filter((snapshot) => snapshot.ts <= nowMs).map((s) => s.ts)).size,
    projection: points,
    nextReset: resets.find((event) => event.gain > 0.5) ?? null,
    allOutAtMs: trace.allEmptyAtMs,
    ...outlook,
    atWindowAverage,
  };
}
