/**
 * The provider forecast's projection: the drain keeps going on the accounts that
 * still have quota, the outlook follows the projection, and an account cooling
 * down stays in the forecast as capacity that is out until it comes back.
 */

import { describe, expect, test } from 'bun:test';
import {
  aggregateHistory,
  buildQuotaForecast,
  clipToRange,
  comparesWindowAverage,
  cooldownReturnMs,
  currentDrain,
  drainSeries,
  measureDrain,
  projectQuota,
  type ChartPoint,
  type LiveReading,
  type ProviderDrain,
} from '@/features/quota/forecast/forecastModel';
import { forecastReadings } from '@/features/quota/forecast/forecastWindows';
import type { QuotaSnapshot } from '@/features/quota/forecast/quotaHistory';
import type { QuotaMeterReading } from '@/features/quota/forecast/quotaMeters';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { projectInSubprocess } from './helpers/forecastInSubprocess';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const WEEK_HOURS = 168;

const reading = (credentialId: string, overrides: Partial<LiveReading> = {}): LiveReading => ({
  credentialId,
  remaining: 100,
  resetAtMs: null,
  periodHours: WEEK_HOURS,
  ratePerHour: null,
  averagePerHour: null,
  ...overrides,
});

/** The projected total at `t`, interpolated between points (a reset is a vertical step). */
const totalAt = (points: ChartPoint[], t: number) => {
  const exact = points.filter((point) => point.t === t);
  if (exact.length > 0) return exact[exact.length - 1].v;
  const after = points.findIndex((point) => point.t >= t);
  if (after <= 0) return points[Math.max(after, 0)].v;
  const [a, b] = [points[after - 1], points[after]];
  return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
};

const forecast = (live: LiveReading[], rangeMs = 3 * DAY_MS) =>
  buildQuotaForecast({
    live,
    history: [],
    nowMs: NOW,
    rangeMs,
    lookbackMs: 5 * HOUR_MS,
    enoughMs: 30 * MINUTE_MS,
  });

describe('the drain after an account empties', () => {
  const live = [
    reading('a', { remaining: 20, ratePerHour: 10, resetAtMs: NOW + 40 * HOUR_MS }),
    reading('b', { remaining: 80, ratePerHour: null, resetAtMs: NOW + 30 * HOUR_MS }),
  ];

  test('keeps falling at the same rate on the accounts that still have quota', () => {
    const { points } = projectQuota(live, 10, NOW, NOW + 12 * HOUR_MS);
    // a empties at 2h; b, with no rate, then takes the whole drain.
    expect(totalAt(points, NOW + 1 * HOUR_MS)).toBeCloseTo(90, 6);
    expect(totalAt(points, NOW + 2 * HOUR_MS)).toBeCloseTo(80, 6);
    expect(totalAt(points, NOW + 4 * HOUR_MS)).toBeCloseTo(60, 6);
    expect(totalAt(points, NOW + 9 * HOUR_MS)).toBeCloseTo(10, 6);
    // b empties at 10h: the provider is out.
    expect(totalAt(points, NOW + 11 * HOUR_MS)).toBe(0);
    expect(forecast(live, 12 * HOUR_MS).allOutAtMs).toBeCloseTo(NOW + 10 * HOUR_MS, -3);
  });

  test('an account emptying mid-step loses no drain', () => {
    // a empties 25 minutes in, partway through the second 10-minute step.
    const midStep = [
      reading('a', { remaining: 5, ratePerHour: 12 }),
      reading('b', { remaining: 50, ratePerHour: null }),
    ];
    const { points } = projectQuota(midStep, 12, NOW, NOW + 3 * HOUR_MS);
    expect(points.some((point) => point.t === NOW + 25 * MINUTE_MS)).toBe(true);
    [20, 25, 31, 40, 75, 120, 170].forEach((minutes) => {
      expect(totalAt(points, NOW + minutes * MINUTE_MS)).toBeCloseTo(55 - 12 * (minutes / 60), 6);
    });
  });

  test('splits the drain by rate among the accounts that have quota', () => {
    const resetAtMs = NOW + 6 * HOUR_MS;
    const { points, trace } = projectQuota(
      [
        reading('a', { remaining: 10, ratePerHour: 6, resetAtMs }),
        reading('b', { remaining: 100, ratePerHour: 3, resetAtMs }),
        reading('c', { remaining: 100, ratePerHour: 1, resetAtMs }),
      ],
      10,
      NOW,
      NOW + 7 * HOUR_MS
    );
    // a takes 6 of the 10 per hour and empties at 10 / 6 = 1h40 (an even split
    // would empty it at 3h). b and c then split the 10 per hour 3 to 1.
    expect(trace.firstEmptyAtMs).toBeCloseTo(NOW + 100 * MINUTE_MS, 3);
    const unused = Object.fromEntries(
      trace.beforeFirstReset.map((item) => [item.credentialId, item.unused])
    );
    // b: 100 - 3 x 5/3 - 7.5 x 13/3; c: 100 - 1 x 5/3 - 2.5 x 13/3.
    expect(unused.a).toBe(0);
    expect(unused.b).toBeCloseTo(62.5, 6);
    expect(unused.c).toBeCloseTo(87.5, 6);
    // The total never stops falling at 10 per hour.
    expect(totalAt(points, NOW + 3 * HOUR_MS)).toBeCloseTo(210 - 30, 6);
    expect(totalAt(points, resetAtMs - 1)).toBeCloseTo(210 - 60, 3);
  });

  test('a refilled account takes part in the split again', () => {
    const two = [
      reading('a', { remaining: 20, ratePerHour: 4, resetAtMs: NOW + 8 * HOUR_MS }),
      reading('b', { remaining: 80, ratePerHour: null, resetAtMs: NOW + 30 * HOUR_MS }),
    ];
    const { points, resets } = projectQuota(two, 4, NOW, NOW + 12 * HOUR_MS);
    // a empties at 5h, b drains 4/h until a resets at 8h (b: 68), then a takes the drain.
    expect(totalAt(points, NOW + 8 * HOUR_MS - 1)).toBeCloseTo(68, 3);
    expect(resets[0]).toMatchObject({ atMs: NOW + 8 * HOUR_MS });
    expect(resets[0].gain).toBeCloseTo(100, 6);
    expect(totalAt(points, NOW + 8 * HOUR_MS)).toBeCloseTo(168, 6);
    expect(totalAt(points, NOW + 12 * HOUR_MS)).toBeCloseTo(152, 6);
  });

  test('the outlook follows the redistributed drain', () => {
    const outlook = forecast(
      [
        reading('a', { remaining: 20, ratePerHour: 4, resetAtMs: NOW + 8 * HOUR_MS }),
        reading('b', { remaining: 80, ratePerHour: null, resetAtMs: NOW + 30 * HOUR_MS }),
      ],
      2 * DAY_MS
    );
    expect(outlook.drain.ratePerHour).toBe(4);
    expect(outlook.firstRunsOutAtMs).toBeCloseTo(NOW + 5 * HOUR_MS, -3);
    expect(outlook.unusedByAccount).toEqual([
      { credentialId: 'a', unused: 0, resetAtMs: NOW + 8 * HOUR_MS },
      { credentialId: 'b', unused: expect.closeTo(68, 3), resetAtMs: NOW + 30 * HOUR_MS },
    ]);
    // Previously b was frozen at 80 once a emptied.
    expect(outlook.unusedAtResets).toBeCloseTo(68, 3);
  });

  test('an account with no reset ahead in the range is left out of the unused quota', () => {
    const outlook = forecast(
      [
        reading('a', { remaining: 50, ratePerHour: 1, resetAtMs: NOW + 5 * DAY_MS }),
        reading('b', { remaining: 50, ratePerHour: 1, resetAtMs: null }),
      ],
      DAY_MS
    );
    expect(outlook.unusedByAccount).toEqual([]);
    expect(outlook.unusedAtResets).toBe(0);
    expect(outlook.firstRunsOutAtMs).toBeNull();
  });
});

describe('the projection always ends', () => {
  test('an account that empties within a fraction of a millisecond does not stall it', () => {
    // 100 accounts at 350% per hour, one serving at 4% and 99 cooling with no
    // known return or reset. The serving account carries 35000% per hour and
    // empties 411.43 ms in: a duration that does not survive being added to an
    // epoch timestamp, which once left a remainder no step could clear.
    const live = Array.from({ length: 100 }, (_, index) =>
      index === 0
        ? reading('serving', { remaining: 4, ratePerHour: 350, periodHours: 5 })
        : reading(`cooling-${index}`, {
            remaining: 0,
            ratePerHour: 350,
            periodHours: 5,
            cooldown: { untilMs: null, returnRemaining: 0 },
          })
    );
    const run = projectInSubprocess({
      live,
      drainPerHour: 35_000,
      nowMs: NOW,
      untilMs: NOW + DAY_MS,
    });
    expect(run).toMatchObject({ finished: true });
    if (!run.finished) return;
    const emptyAtMs = NOW + (4 / 35_000) * HOUR_MS;
    expect(run.result.trace.firstEmptyAtMs).toBeCloseTo(emptyAtMs, 3);
    expect(totalAt(run.result.points, emptyAtMs)).toBe(0);
    expect(totalAt(run.result.points, NOW + DAY_MS)).toBe(0);
  }, 30_000);
});

describe('an account cooling down', () => {
  const serving = reading('serving', { remaining: 60, ratePerHour: 5 });
  const cooling = (overrides: Partial<LiveReading> = {}) =>
    reading('cooling', {
      remaining: 0,
      ratePerHour: 5,
      resetAtMs: NOW + 3 * DAY_MS,
      cooldown: { untilMs: NOW + 2 * HOUR_MS, returnRemaining: 30 },
      ...overrides,
    });

  test('counts toward capacity at 0% and takes no drain until its cooldown ends', () => {
    const result = forecast([serving, cooling()], DAY_MS);
    expect(result.capacity).toBe(200);
    expect(result.remaining).toBe(60);
    // Without enough history the drain is the serving account's rate alone:
    // the cooling account's old pace is not added on top of it.
    expect(result.drain).toMatchObject({ ratePerHour: 5, source: 'window' });
    expect(totalAt(result.projection, NOW + 1 * HOUR_MS)).toBeCloseTo(55, 6);
    expect(totalAt(result.projection, NOW + 2 * HOUR_MS - 1)).toBeCloseTo(50, 3);
  });

  test('comes back at its last reading when its window resets after the cooldown', () => {
    const result = forecast([serving, cooling()], DAY_MS);
    expect(result.nextReset).toEqual({ atMs: NOW + 2 * HOUR_MS, gain: 30 });
    expect(totalAt(result.projection, NOW + 2 * HOUR_MS)).toBeCloseTo(50 + 30, 6);
    // Both accounts split the 5 per hour from there, 2.5 each.
    expect(totalAt(result.projection, NOW + 4 * HOUR_MS)).toBeCloseTo(80 - 10, 6);
  });

  test('comes back at 100% when its window reset is at or before the cooldown end', () => {
    [NOW + 1 * HOUR_MS, NOW + 2 * HOUR_MS].forEach((resetAtMs) => {
      const result = forecast([serving, cooling({ resetAtMs })], DAY_MS);
      expect(result.nextReset).toEqual({ atMs: NOW + 2 * HOUR_MS, gain: 100 });
      expect(totalAt(result.projection, NOW + 2 * HOUR_MS)).toBeCloseTo(50 + 100, 6);
    });
  });

  test('a daily or longer window that reset during the cooldown keeps its reset schedule', () => {
    // A 24-hour window resets at +1h and the account is back at +2h: its window
    // then resets at +25h and +49h, not a period after the return.
    const { resets } = projectQuota(
      [serving, cooling({ periodHours: 24, resetAtMs: NOW + 1 * HOUR_MS })],
      2,
      NOW,
      NOW + 3 * DAY_MS
    );
    expect(resets.map((event) => event.atMs)).toEqual([
      NOW + 2 * HOUR_MS,
      NOW + 25 * HOUR_MS,
      NOW + 49 * HOUR_MS,
    ]);
  });

  test('a 5-hour window that reset during the cooldown starts again when the account is back', () => {
    // A 5-hour window starts again on the next request (the rule meterAsOf
    // follows), and the account takes requests again from its return at +2h.
    const { resets } = projectQuota(
      [serving, cooling({ periodHours: 5, resetAtMs: NOW + 1 * HOUR_MS })],
      2,
      NOW,
      NOW + DAY_MS
    );
    expect(resets.map((event) => event.atMs)).toEqual(
      [2, 7, 12, 17, 22].map((hours) => NOW + hours * HOUR_MS)
    );
  });

  test('with an unknown cooldown end it stays out until its window reset', () => {
    const result = forecast(
      [
        serving,
        cooling({ cooldown: { untilMs: null, returnRemaining: 30 }, resetAtMs: NOW + HOUR_MS }),
      ],
      DAY_MS
    );
    expect(result.nextReset).toEqual({ atMs: NOW + HOUR_MS, gain: 100 });
    expect(result.outNow).toEqual({ count: 1, backAtMs: NOW + HOUR_MS });
  });

  test('with an unknown cooldown end and no reset it stays out for the whole range', () => {
    const result = forecast(
      [serving, cooling({ cooldown: { untilMs: null, returnRemaining: 30 }, resetAtMs: null })],
      DAY_MS
    );
    expect(result.nextReset).toBeNull();
    expect(result.outNow).toEqual({ count: 1, backAtMs: null });
    // The serving account alone carries the whole drain: 60 / 5 = 12h.
    expect(result.allOutAtMs).toBeCloseTo(NOW + 12 * HOUR_MS, -3);
  });

  test('is counted as out now and back when its cooldown ends', () => {
    const result = forecast([serving, cooling()], DAY_MS);
    expect(result.outNow).toEqual({ count: 1, backAtMs: NOW + 2 * HOUR_MS });
    expect(cooldownReturnMs(cooling(), NOW)).toBe(NOW + 2 * HOUR_MS);
    expect(cooldownReturnMs(serving, NOW)).toBeNull();
  });

  test('back before its window reset, what it still holds at that reset is unused', () => {
    // Back at +1h with 80% and no share of the drain (rate 0): its window
    // discards that 80% when it resets at +4h.
    const result = forecast(
      [
        reading('serving', { remaining: 100, ratePerHour: 1 }),
        cooling({
          ratePerHour: 0,
          resetAtMs: NOW + 4 * HOUR_MS,
          cooldown: { untilMs: NOW + 1 * HOUR_MS, returnRemaining: 80 },
        }),
      ],
      DAY_MS
    );
    expect(result.unusedByAccount).toEqual([
      { credentialId: 'cooling', unused: 80, resetAtMs: NOW + 4 * HOUR_MS },
    ]);
    expect(result.unusedAtResets).toBe(80);
    // The serving account had quota now: it alone sets the first run-out.
    expect(result.firstRunsOutAtMs).toBeNull();
  });

  test('a window reset that passes while it is still out counts as unused 0', () => {
    // Its window resets at +4h; it is back at +6h, or only after the range.
    [NOW + 6 * HOUR_MS, NOW + 2 * DAY_MS].forEach((untilMs) => {
      const result = forecast(
        [
          reading('serving', { remaining: 100, ratePerHour: 1 }),
          cooling({ resetAtMs: NOW + 4 * HOUR_MS, cooldown: { untilMs, returnRemaining: 30 } }),
        ],
        DAY_MS
      );
      expect(result.unusedByAccount).toEqual([
        { credentialId: 'cooling', unused: 0, resetAtMs: NOW + 4 * HOUR_MS },
      ]);
      expect(result.unusedAtResets).toBe(0);
    });
  });
});

describe('a cooling credential whose window reset before now', () => {
  // Its 5-hour window reset at -30m while CLIProxyAPI still benches it until +1h.
  const benched = {
    id: 'cooling',
    meters: [
      {
        id: 'five-hour',
        label: '5-hour',
        remaining: 2,
        resetAtMs: NOW - 30 * MINUTE_MS,
        periodHours: 5,
        primary: false,
      } satisfies QuotaMeterReading,
    ],
  };
  // The serving account's own reset is known and beyond the range, so these
  // tests see only the cooling account's resets.
  const servingWindow = {
    remaining: 60,
    ratePerHour: 20,
    periodHours: 5,
    resetAtMs: NOW + 100 * HOUR_MS,
  };
  const readings = (untilMs: number | null = NOW + 1 * HOUR_MS) =>
    forecastReadings({ usable: [], out: [{ entry: benched, untilMs }] }, 'session', {
      metersFor: (entry) => entry.meters,
      credentialIdFor: (entry) => entry.id,
      snapshotsFor: () => [],
      nowMs: NOW,
      lookbackMs: 5 * HOUR_MS,
    });

  test('keeps the window reset and period it was read with', () => {
    expect(readings()).toEqual([
      expect.objectContaining({
        credentialId: 'cooling',
        remaining: 0,
        resetAtMs: NOW - 30 * MINUTE_MS,
        periodHours: 5,
        cooldown: { untilMs: NOW + 1 * HOUR_MS, returnRemaining: 2 },
      }),
    ]);
  });

  test('comes back to a full window that starts again, with resets after it', () => {
    const live = [reading('serving', servingWindow), ...readings()];
    const result = forecast(live, DAY_MS);
    expect(result.drain.ratePerHour).toBe(20);
    const { resets } = projectQuota(live, 20, NOW, NOW + DAY_MS);
    // Back at +1h at 100%; its window starts again then and resets every 5 hours.
    expect(resets[0]).toEqual({ atMs: NOW + 1 * HOUR_MS, gain: 100 });
    expect(resets.map((event) => event.atMs)).toEqual(
      [1, 6, 11, 16, 21].map((hours) => NOW + hours * HOUR_MS)
    );
    // The serving account empties at +3h; the returned one carries the 20 per
    // hour from there and refills at +6h, so the provider is not out at +8h.
    expect(totalAt(result.projection, NOW + 8 * HOUR_MS)).toBeCloseTo(60, 6);
    expect(totalAt(result.projection, NOW + DAY_MS)).toBeCloseTo(40, 6);
  });

  test('with an unknown cooldown end it stays out: its reset is behind it', () => {
    const result = forecast([reading('serving', servingWindow), ...readings(null)], DAY_MS);
    expect(result.outNow).toEqual({ count: 1, backAtMs: null });
    expect(result.nextReset).toBeNull();
  });
});

describe('a serving 5-hour account whose window reset has passed', () => {
  // Its reset is behind it (resetAtMs null, as meterAsOf reads a passed 5-hour
  // reset), so its next window starts with its first request in the projection.
  const passed = (overrides: Partial<LiveReading> = {}) =>
    reading('passed', { periodHours: 5, ratePerHour: 50, ...overrides });

  test('starts its window when it first receives drain, and refills a period later', () => {
    // 50 per hour empties it at +2h; its window started at +0h, so it resets at +5h.
    const { points, resets } = projectQuota([passed()], 50, NOW, NOW + 12 * HOUR_MS);
    expect(totalAt(points, NOW + 2 * HOUR_MS)).toBe(0);
    expect(totalAt(points, NOW + 4 * HOUR_MS)).toBe(0);
    expect(totalAt(points, NOW + 5 * HOUR_MS)).toBeCloseTo(100, 6);
    expect(totalAt(points, NOW + 6 * HOUR_MS)).toBeCloseTo(50, 6);
    expect(totalAt(points, NOW + 7 * HOUR_MS)).toBe(0);
    expect(totalAt(points, NOW + 9 * HOUR_MS)).toBe(0);
    // The refill starts the next window, a period after the first.
    expect(resets.map((event) => event.atMs)).toEqual(
      [5, 10].map((hours) => NOW + hours * HOUR_MS)
    );
    resets.forEach((event) => expect(event.gain).toBeCloseTo(100, 6));
  });

  test('starts its window at the moment drain first reaches it', () => {
    // b carries the whole rate until it empties at +1h; only then does the
    // passed account take drain, so its window starts at +1h and resets at +6h.
    const { resets } = projectQuota(
      [
        passed({ ratePerHour: null }),
        reading('b', {
          remaining: 50,
          ratePerHour: 50,
          resetAtMs: NOW + 30 * HOUR_MS,
        }),
      ],
      50,
      NOW,
      NOW + 12 * HOUR_MS
    );
    expect(resets.map((event) => event.atMs)).toEqual(
      [6, 11].map((hours) => NOW + hours * HOUR_MS)
    );
  });

  test('gets no reset event while it receives no drain', () => {
    // b has all the rate and does not empty in 12 hours: 5 per hour on 100.
    const { points, resets, trace } = projectQuota(
      [
        passed({ ratePerHour: null }),
        reading('b', { ratePerHour: 5, resetAtMs: NOW + 100 * HOUR_MS }),
      ],
      5,
      NOW,
      NOW + 12 * HOUR_MS
    );
    expect(resets).toEqual([]);
    expect(trace.beforeFirstReset).toEqual([]);
    expect(totalAt(points, NOW + 12 * HOUR_MS)).toBeCloseTo(200 - 60, 6);
  });

  test('a window of a day or longer with no known reset gets no reset', () => {
    const { resets } = projectQuota(
      [reading('weekly', { ratePerHour: 50 })],
      50,
      NOW,
      NOW + 12 * HOUR_MS
    );
    expect(resets).toEqual([]);
  });
});

const snapshot = (credentialId: string, hoursAgo: number, remaining: number): QuotaSnapshot => ({
  connection: 'test',
  ts: NOW - hoursAgo * HOUR_MS,
  credentialId,
  provider: 'claude',
  window: 'five-hour',
  remaining,
  resetAtMs: null,
  primary: false,
});
// a used 60% at 20 per hour and ran out 2 hours ago; it is cooling. b has
// carried the traffic since, at 10 per hour.
const ranOut = reading('a', {
  remaining: 0,
  ratePerHour: 20,
  averagePerHour: 20,
  cooldown: { untilMs: NOW + 3 * HOUR_MS, returnRemaining: 0 },
});
const carrying = reading('b', { remaining: 80, ratePerHour: 10, averagePerHour: 4 });
const history = [
  ...[5, 4.5, 4, 3.5, 3, 2.5, 2].map((hours, index) => snapshot('a', hours, 60 - 10 * index)),
  ...[2, 1.5, 1, 0.5, 0].map((hours, index) => snapshot('b', hours, 100 - 5 * index)),
];

describe('the provider drain', () => {
  const drain = (recorded: QuotaSnapshot[], enoughMs = 30 * MINUTE_MS, live = [ranOut, carrying]) =>
    currentDrain(live, recorded, NOW, 5 * HOUR_MS, enoughMs);

  test("follows all accounts' recorded readings once they cover enough of the lookback", () => {
    // 60 from a until it ran out, and 20 from b since, over the 5 hours covered.
    expect(drain(history)).toEqual({
      ratePerHour: 16,
      source: 'history',
      coveredMs: 5 * HOUR_MS,
      windowAverage: 24,
    });
  });

  test('falls back to the rates of the accounts not cooling when the readings cover too little', () => {
    expect(drain(history, 6 * HOUR_MS)).toEqual({
      ratePerHour: 10,
      source: 'window',
      coveredMs: 5 * HOUR_MS,
      windowAverage: 24,
    });
  });

  test('with every account cooling, falls back to all their rates', () => {
    const benched = { ...carrying, remaining: 0, cooldown: ranOut.cooldown };
    expect(drain([], 30 * MINUTE_MS, [ranOut, benched])).toEqual({
      ratePerHour: 30,
      source: 'window',
      coveredMs: 0,
      windowAverage: 24,
    });
  });

  test('the projection keeps the recent pace on the account carrying the traffic', () => {
    const result = buildQuotaForecast({
      live: [ranOut, carrying],
      history,
      nowMs: NOW,
      rangeMs: DAY_MS,
      lookbackMs: 5 * HOUR_MS,
      enoughMs: 30 * MINUTE_MS,
    });
    // b alone takes the 16 per hour: 80 / 16 = 5h.
    expect(totalAt(result.projection, NOW + 2 * HOUR_MS)).toBeCloseTo(80 - 32, 6);
    expect(result.allOutAtMs).toBeCloseTo(NOW + 5 * HOUR_MS, -3);
  });
});

describe('the projection at the window-average pace', () => {
  const build = (recorded: QuotaSnapshot[], live = [ranOut, carrying]) =>
    buildQuotaForecast({
      live,
      history: recorded,
      nowMs: NOW,
      rangeMs: DAY_MS,
      lookbackMs: 5 * HOUR_MS,
      enoughMs: 30 * MINUTE_MS,
    });
  const withAverages = (a: number | null, b: number | null) => [
    { ...ranOut, averagePerHour: a },
    { ...carrying, averagePerHour: b },
  ];

  test('runs the same simulation, accounts and range at the window average', () => {
    const result = build(history);
    expect(result.drain).toMatchObject({ ratePerHour: 16, source: 'history', windowAverage: 24 });
    const average = projectQuota([ranOut, carrying], 24, NOW, NOW + DAY_MS);
    expect(result.atWindowAverage).toEqual({
      ratePerHour: 24,
      projection: average.points,
      firstRunsOutAtMs: average.trace.firstEmptyAtMs,
      allOutAtMs: expect.any(Number),
    });
    // b alone takes the 24 per hour: 80 / 24 = 3h20, against 80 / 16 = 5h.
    expect(result.atWindowAverage?.allOutAtMs).toBeCloseTo(NOW + 200 * MINUTE_MS, -3);
    expect(result.atWindowAverage?.firstRunsOutAtMs).toBeCloseTo(NOW + 200 * MINUTE_MS, -3);
    expect(result.allOutAtMs).toBeCloseTo(NOW + 5 * HOUR_MS, -3);
  });

  test('is left out when the drain is not measured from history', () => {
    const result = build([]);
    expect(result.drain.source).toBe('window');
    expect(result.atWindowAverage).toBeNull();
  });

  test('shows only when the two paces differ by more than 5%', () => {
    // 16 per hour recent against 16.8 (4.8% apart) and 16.9 (5.3% apart).
    expect(build(history, withAverages(12.8, 4)).atWindowAverage).toBeNull();
    expect(build(history, withAverages(12.9, 4)).atWindowAverage).toMatchObject({
      ratePerHour: 16.9,
    });
    // The other way round: 15.3 is 4.4% under 16, 15.1 is 5.6% under.
    expect(build(history, withAverages(11.3, 4)).atWindowAverage).toBeNull();
    expect(build(history, withAverages(11.1, 4)).atWindowAverage).not.toBeNull();
  });

  test('is left out when no window has a known average', () => {
    expect(build(history, withAverages(null, null)).atWindowAverage).toBeNull();
    const drain: ProviderDrain = {
      ratePerHour: 16,
      source: 'history',
      coveredMs: 5 * HOUR_MS,
      windowAverage: 0,
    };
    expect(comparesWindowAverage(drain, withAverages(null, null))).toBe(false);
    // A known average of 0 (idle windows) is a pace worth comparing.
    expect(comparesWindowAverage(drain, withAverages(0, 0))).toBe(true);
  });
});

describe('the drain measured across the start of the lookback', () => {
  const measure = (readings: [number, number][], lookbackHours = 5, minCoveredMs?: number) =>
    measureDrain(
      readings.map(([hoursAgo, remaining]) => snapshot('a', hoursAgo, remaining)),
      NOW - lookbackHours * HOUR_MS,
      NOW,
      minCoveredMs
    );

  test('counts only the share of the interval that crosses the start', () => {
    // A constant 10 per hour. The reading 7h ago is before the lookback: the 2h
    // of the 2.5h gap that lie outside it are not consumption inside it.
    const measured = measure([
      [7, 100],
      [4.5, 75],
      [2.5, 55],
      [0, 30],
    ]);
    expect(measured?.coveredMs).toBe(5 * HOUR_MS);
    expect(measured?.ratePerHour).toBeCloseTo(10, 9);
  });

  test('prorates an irregular reading that straddles the start', () => {
    // 6h ago 90, 4h ago 70 (10 per hour), then 3h ago 70 and now 40. At the
    // start (5h ago) the interpolated value is 80, so 80 - 40 = 40 over 5h.
    const measured = measure([
      [6, 90],
      [4, 70],
      [3, 70],
      [0, 40],
    ]);
    expect(measured?.coveredMs).toBe(5 * HOUR_MS);
    expect(measured?.ratePerHour).toBeCloseTo(8, 9);
  });

  test('an interval crossing the start with no drop adds nothing', () => {
    // 100 held from 6h to 3.5h ago, so the value at the start is 100 and the
    // 30 consumed since is spread over the 5h.
    const measured = measure([
      [6, 100],
      [3.5, 100],
      [1, 80],
      [0, 70],
    ]);
    expect(measured?.coveredMs).toBe(5 * HOUR_MS);
    expect(measured?.ratePerHour).toBeCloseTo(6, 9);
  });

  test('a gap over the limit before the start is not interpolated across', () => {
    // The reading 9h ago is 6.5h from the next: no run reaches the start, so
    // only the readings inside count.
    const measured = measure([
      [9, 100],
      [2.5, 40],
      [0, 30],
    ]);
    expect(measured?.coveredMs).toBe(2.5 * HOUR_MS);
    expect(measured?.ratePerHour).toBeCloseTo(4, 9);
  });

  test('a reset between the reading before the start and the next splits the run', () => {
    const before = { ...snapshot('a', 6, 20), resetAtMs: NOW - 5.5 * HOUR_MS };
    const inside = [snapshot('a', 4, 100), snapshot('a', 2, 80), snapshot('a', 0, 60)];
    const measured = measureDrain([before, ...inside], NOW - 5 * HOUR_MS, NOW);
    expect(measured?.coveredMs).toBe(4 * HOUR_MS);
    expect(measured?.ratePerHour).toBeCloseTo(10, 9);
  });

  test('the drain series reads the same constant pace across its windows', () => {
    const recorded = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((hoursAgo) =>
      snapshot('a', hoursAgo, 100 - 10 * (8 - hoursAgo))
    );
    const { segments } = drainSeries(recorded, NOW, 8 * HOUR_MS);
    const values = segments.flat().map((point) => point.v);
    expect(values.length).toBeGreaterThan(0);
    values.forEach((value) => expect(value).toBeCloseTo(10, 6));
  });
});

describe('when the whole provider runs out', () => {
  const build = (remaining: number, rate: number, history: QuotaSnapshot[] = []) =>
    buildQuotaForecast({
      live: ['a', 'b'].map((id) =>
        reading(id, { remaining, ratePerHour: rate, resetAtMs: NOW + HOUR_MS })
      ),
      history,
      nowMs: NOW,
      rangeMs: DAY_MS,
      lookbackMs: 5 * HOUR_MS,
      enoughMs: 30 * MINUTE_MS,
    });

  test('is not reported while quota remains until the resets', () => {
    // Each account ends the hour at 0.1%, then refills: neither empties.
    const result = build(1, 0.9);
    expect(result.firstRunsOutAtMs).toBeNull();
    expect(result.allOutAtMs).toBeNull();
  });

  test('is the moment every account is empty', () => {
    // 5% each at 10 per hour each (20 in all): both empty together after 30 min.
    const result = buildQuotaForecast({
      live: ['a', 'b'].map((id) => reading(id, { remaining: 5, ratePerHour: 10 })),
      history: [],
      nowMs: NOW,
      rangeMs: DAY_MS,
      lookbackMs: 5 * HOUR_MS,
      enoughMs: 30 * MINUTE_MS,
    });
    expect(result.firstRunsOutAtMs).toBeCloseTo(NOW + 30 * MINUTE_MS, -3);
    expect(result.allOutAtMs).toBeCloseTo(NOW + 30 * MINUTE_MS, -3);
  });

  test('waits for the last account when the first empties earlier', () => {
    const result = buildQuotaForecast({
      live: [
        reading('a', { remaining: 5, ratePerHour: 10 }),
        reading('b', { remaining: 50, ratePerHour: 10 }),
      ],
      history: [],
      nowMs: NOW,
      rangeMs: DAY_MS,
      lookbackMs: 5 * HOUR_MS,
      enoughMs: 30 * MINUTE_MS,
    });
    // 20 per hour split evenly: a empties at 30 min, then b alone at 20 per hour.
    expect(result.firstRunsOutAtMs).toBeCloseTo(NOW + 30 * MINUTE_MS, -3);
    expect(result.allOutAtMs).toBeCloseTo(NOW + 30 * MINUTE_MS + (45 / 20) * HOUR_MS, -3);
  });

  describe('in the window-average projection', () => {
    // Recorded pace: 0.2 per hour across both accounts.
    const recorded = ['a', 'b'].flatMap((id) =>
      [3, 2, 1, 0].map((hours, index) => snapshot(id, hours, 100 - 0.1 * index))
    );
    const compare = (averagePerHour: number) =>
      buildQuotaForecast({
        live: ['a', 'b'].map((id) =>
          reading(id, { remaining: 1, ratePerHour: 0.9, averagePerHour, resetAtMs: NOW + HOUR_MS })
        ),
        history: recorded,
        nowMs: NOW,
        rangeMs: DAY_MS,
        lookbackMs: 5 * HOUR_MS,
        enoughMs: 30 * MINUTE_MS,
      });

    test('is not reported while quota remains until the resets', () => {
      // 0.9 per hour each: 0.1% left on each just before the reset.
      const result = compare(0.9);
      expect(result.drain.source).toBe('history');
      expect(result.atWindowAverage?.firstRunsOutAtMs).toBeNull();
      expect(result.atWindowAverage?.allOutAtMs).toBeNull();
    });

    test('is the moment every account is empty when it does run out', () => {
      // 20 per hour in all: 2 points gone in 6 minutes.
      const result = compare(10);
      expect(result.atWindowAverage?.allOutAtMs).toBeCloseTo(NOW + 6 * MINUTE_MS, -3);
    });
  });
});

describe('the recorded history line', () => {
  const weekly = (
    credentialId: string,
    hoursAgo: number,
    remaining: number,
    resetAtMs: number | null = null
  ): QuotaSnapshot => ({
    connection: 'test',
    ts: NOW - hoursAgo * HOUR_MS,
    credentialId,
    provider: 'claude',
    window: 'seven-day',
    remaining,
    resetAtMs,
    primary: true,
  });
  /** Every half hour from `fromHours` ago to now. */
  const halfHours = (fromHours: number) =>
    Array.from({ length: fromHours * 2 + 1 }, (_, index) => fromHours - index / 2);
  const both = new Set(['a', 'b']);

  test('keeps an idle account at its last reading, however old', () => {
    // a serves traffic and is read every half hour; b was read once, 8 hours ago.
    const history = [
      ...halfHours(8).map((hours, index) => weekly('a', hours, 50 - index)),
      weekly('b', 8, 100),
    ];
    const [line, ...rest] = aggregateHistory(history, both, NOW);
    expect(rest).toHaveLength(0);
    expect(line).toHaveLength(17);
    line.forEach((point, index) => expect(point.v).toBe(150 - index));
  });

  test('starts once every account has a reading', () => {
    const history = [...halfHours(8).map((hours) => weekly('a', hours, 50)), weekly('b', 6, 100)];
    const [line] = aggregateHistory(history, both, NOW);
    expect(line[0]).toEqual({ t: NOW - 6 * HOUR_MS, v: 150 });
  });

  test("refills an idle account at its reset's time", () => {
    const resetAt = NOW - 3 * HOUR_MS;
    const history = [
      ...halfHours(8).map((hours) => weekly('a', hours, 50)),
      weekly('b', 8, 20, resetAt),
    ];
    const [line] = aggregateHistory(history, both, NOW);
    expect(line.find((point) => point.t === resetAt - 1)?.v).toBe(70);
    expect(line.find((point) => point.t === resetAt)?.v).toBe(150);
    expect(line[line.length - 1].v).toBe(150);
  });

  test('holds across a silence and steps at the next reading', () => {
    const history = [weekly('a', 10, 60), weekly('a', 0, 50)];
    expect(aggregateHistory(history, new Set(['a']), NOW)).toEqual([
      [
        { t: NOW - 10 * HOUR_MS, v: 60 },
        { t: NOW - 1, v: 60 },
        { t: NOW, v: 50 },
      ],
    ]);
  });

  test('holds after a reset inside a silence until the next reading', () => {
    const history = [weekly('a', 10, 20, NOW - 6 * HOUR_MS), weekly('a', 4, 60)];
    expect(aggregateHistory(history, new Set(['a']), NOW)).toEqual([
      [
        { t: NOW - 10 * HOUR_MS, v: 20 },
        { t: NOW - 6 * HOUR_MS - 1, v: 20 },
        { t: NOW - 6 * HOUR_MS, v: 100 },
        { t: NOW - 4 * HOUR_MS - 1, v: 100 },
        { t: NOW - 4 * HOUR_MS, v: 60 },
        { t: NOW, v: 60 },
      ],
    ]);
  });

  test('refills at a reset after the last reading, and runs to now', () => {
    const history = [weekly('a', 2, 20, NOW - HOUR_MS)];
    expect(aggregateHistory(history, new Set(['a']), NOW)).toEqual([
      [
        { t: NOW - 2 * HOUR_MS, v: 20 },
        { t: NOW - HOUR_MS - 1, v: 20 },
        { t: NOW - HOUR_MS, v: 100 },
        { t: NOW, v: 100 },
      ],
    ]);
  });

  test("steps at a reset in the same minute as another account's last reading", () => {
    const history = [weekly('a', 2, 20, NOW - HOUR_MS), weekly('b', 2, 50), weekly('b', 1, 50)];
    const [line] = aggregateHistory(history, both, NOW);
    expect(line.find((point) => point.t === NOW - HOUR_MS - 1)?.v).toBe(70);
    expect(line.find((point) => point.t === NOW - HOUR_MS)?.v).toBe(150);
  });

  test('counts a reset before a reading in the same minute', () => {
    // a was out until 10s past the minute and served again 10s later.
    const minute = NOW - HOUR_MS;
    const history = [
      weekly('a', 2, 0, minute + 10_000),
      weekly('a', (NOW - minute - 20_000) / HOUR_MS, 99),
      weekly('a', 0, 95),
    ];
    const [line] = aggregateHistory(history, new Set(['a']), NOW);
    expect(totalAt(line, NOW - 1.5 * HOUR_MS)).toBe(0);
    expect(line.find((point) => point.t === minute - 1)?.v).toBe(0);
    expect(line.find((point) => point.t === minute)?.v).toBe(99);
  });

  test('puts a reset at half past the minute in the next minute', () => {
    // a read 5% at 5s past the minute; its window resets at 30s past.
    const minute = NOW - HOUR_MS;
    const reset = minute + 30_000;
    const history = [
      weekly('a', 3, 15, reset),
      weekly('a', (NOW - minute - 5_000) / HOUR_MS, 5, reset),
    ];
    const [line] = aggregateHistory(history, new Set(['a']), NOW);
    expect(line.find((point) => point.t === minute)?.v).toBe(5);
    expect(line.find((point) => point.t === minute + MINUTE_MS - 1)?.v).toBe(5);
    expect(line.find((point) => point.t === minute + MINUTE_MS)?.v).toBe(100);
  });

  test('does not count a reset that is still ahead of now', () => {
    const history = [weekly('a', 2, 15, NOW + 14_000), weekly('a', 1 / 3600, 5, NOW + 14_000)];
    const [line] = aggregateHistory(history, new Set(['a']), NOW);
    expect(line[line.length - 1]).toEqual({ t: NOW, v: 5 });
  });

  test('counts only the accounts the forecast counts', () => {
    // 'gone' was removed: its readings stay in the browser's history.
    const history = [
      ...halfHours(2).map((hours) => weekly('a', hours, 40)),
      ...halfHours(2).map((hours) => weekly('gone', hours, 100)),
    ];
    const result = buildQuotaForecast({
      live: [reading('a', { remaining: 40 })],
      history,
      nowMs: NOW,
      rangeMs: 3 * DAY_MS,
      lookbackMs: 5 * HOUR_MS,
      enoughMs: 30 * MINUTE_MS,
    });
    expect(result.history.flat().every((point) => point.v === 40)).toBe(true);
  });
});

describe('a chart line clipped to the visible range', () => {
  test('keeps a hold that started before the range', () => {
    const line = [
      { t: NOW - 10 * HOUR_MS, v: 60 },
      { t: NOW - 1, v: 60 },
      { t: NOW, v: 50 },
    ];
    expect(clipToRange(line, NOW - 4 * HOUR_MS, NOW + HOUR_MS)).toEqual([
      { t: NOW - 4 * HOUR_MS, v: 60 },
      { t: NOW - 1, v: 60 },
      { t: NOW, v: 50 },
    ]);
  });

  test('adds a point on each edge a line crosses', () => {
    const line = [
      { t: 0, v: 0 },
      { t: 10, v: 100 },
    ];
    expect(clipToRange(line, 2, 8)).toEqual([
      { t: 2, v: 20 },
      { t: 8, v: 80 },
    ]);
  });

  test('leaves a line inside the range unchanged', () => {
    const line = [
      { t: 3, v: 1 },
      { t: 5, v: 2 },
    ];
    expect(clipToRange(line, 2, 8)).toEqual(line);
  });
});
