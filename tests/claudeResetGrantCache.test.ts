/**
 * When a Claude card reads its reset grants upstream.
 *
 * The cards' effect asks `plan` on every activation (mount, a new quota
 * state, a control toggling); these tests replay those activations against the
 * cache the way the effect does.
 */

import { describe, expect, test } from 'bun:test';
import type { AnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';
import type { StoredResetGrants } from '@/features/quota/forecast/quotaHistory';
import {
  RESET_GRANT_CACHE_TTL_MS,
  claudeWeeklyResetAtMs,
  createResetGrantCache,
  requestResetGrantReads,
  resetGrantCache,
  weeklyResetMoved,
} from '@/features/quota/providers/claude/resetGrantCache';
import type { ClaudeQuotaState } from '@/types';
import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const WEEKLY_RESET = Date.parse('2026-11-04T09:00:00Z');
const CONNECTION = 'http://panel.test';
const status = (resetsLeft: number): AnthropicResetGrantStatus => ({
  eligible: true,
  ineligibleReason: null,
  atLimit: false,
  grants: [
    {
      id: 'grant',
      label: '',
      resetsTotal: 2,
      resetsLeft,
      startsAt: null,
      endsAt: null,
      clears: ['seven_day'],
      paused: false,
      usableNow: true,
      useRequiresLimit: true,
      percentUsed: {},
    },
  ],
  nextGrantId: 'grant',
  weeklyResetsAt: null,
  cooldownUntil: null,
});

/** A Claude quota state as the page builds it from a live read or a passive snapshot. */
const quota = (weeklyResetAtMs: number, observedAt: string): ClaudeQuotaState => ({
  status: 'success',
  windows: [
    { id: 'five-hour', label: '5-hour', usedPercent: 10, resetLabel: '', resetAtMs: NOW },
    {
      id: 'seven-day',
      label: '7-day',
      usedPercent: 20,
      resetLabel: '',
      resetAtMs: weeklyResetAtMs,
    },
  ],
  observedAt,
});

/** A cache over a persistent store that outlives one cache (a page reload). */
function setup(persisted = new Map<string, StoredResetGrants>()) {
  const clock = { now: NOW };
  const cache = createResetGrantCache({
    now: () => clock.now,
    load: async (connection, authIndex) => persisted.get(`${connection}|${authIndex}`),
    save: async (record) => {
      persisted.set(`${record.connection}|${record.authIndex}`, record);
    },
  });
  /** One effect activation: plan, and read upstream when due. */
  let reads = 0;
  const activate = async (weeklyResetAtMs: number | null, readResult = status(1)) => {
    const plan = await cache.plan(CONNECTION, 'a', weeklyResetAtMs);
    if (!plan.read) return plan.status;
    reads += 1;
    cache.store(CONNECTION, 'a', weeklyResetAtMs, readResult);
    return readResult;
  };
  return { cache, clock, persisted, activate, reads: () => reads };
}

describe('Claude reset-grant reads', () => {
  test('a new quota object with the same 7-day reset does not read again', async () => {
    const h = setup();
    // Live read, then two passive snapshots: new objects, newer observedAt,
    // and the header's whole-second reset next to the JSON's microseconds.
    const live = quota(WEEKLY_RESET + 0.943, '2026-10-31T12:00:00Z');
    const passive = quota(WEEKLY_RESET, '2026-10-31T12:02:00Z');
    const later = quota(WEEKLY_RESET, '2026-10-31T12:04:00Z');
    expect(passive).not.toBe(live);

    await h.activate(claudeWeeklyResetAtMs(live));
    for (const state of [passive, later, live, passive]) {
      h.clock.now += 2 * MINUTE_MS;
      expect(await h.activate(claudeWeeklyResetAtMs(state))).toEqual(status(1));
    }
    expect(h.reads()).toBe(1);
  });

  test('reads again when the 7-day reset moves', async () => {
    const h = setup();
    await h.activate(WEEKLY_RESET);
    await h.activate(WEEKLY_RESET + 30_000);
    expect(h.reads()).toBe(1);
    await h.activate(WEEKLY_RESET + 7 * DAY_MS);
    expect(h.reads()).toBe(2);
    // An unknown reset (no 7-day window yet) is not a change.
    await h.activate(null);
    expect(h.reads()).toBe(2);
    expect(weeklyResetMoved(null, WEEKLY_RESET)).toBe(false);
  });

  test('an explicit refresh reads again inside the cache window', async () => {
    const h = setup();
    await h.activate(WEEKLY_RESET);
    let notified = 0;
    const unsubscribe = h.cache.subscribe(() => (notified += 1));
    const before = h.cache.version();
    h.cache.request(CONNECTION, ['a']);
    expect(notified).toBe(1);
    expect(h.cache.version()).not.toBe(before);
    const plan = await h.cache.plan(CONNECTION, 'a', WEEKLY_RESET);
    // The previous grants stay on screen while the read runs.
    expect(plan).toEqual({ status: status(1), read: true });
    await h.activate(WEEKLY_RESET, status(0));
    expect(h.reads()).toBe(2);
    // The request is spent by the read.
    expect(await h.activate(WEEKLY_RESET)).toEqual(status(0));
    expect(h.reads()).toBe(2);
    unsubscribe();
  });

  test('caches a read for 15 minutes', async () => {
    const h = setup();
    expect(RESET_GRANT_CACHE_TTL_MS).toBe(15 * MINUTE_MS);
    await h.activate(WEEKLY_RESET);
    h.clock.now = NOW + RESET_GRANT_CACHE_TTL_MS - 1;
    await h.activate(WEEKLY_RESET);
    expect(h.reads()).toBe(1);
    h.clock.now = NOW + RESET_GRANT_CACHE_TTL_MS;
    await h.activate(WEEKLY_RESET);
    expect(h.reads()).toBe(2);
  });

  test('a reload inside the window uses the stored read', async () => {
    const first = setup();
    await first.activate(WEEKLY_RESET);
    const reloaded = setup(first.persisted);
    reloaded.clock.now = NOW + 10 * MINUTE_MS;
    expect(reloaded.cache.peek(CONNECTION, 'a')).toBeNull();
    expect(await reloaded.activate(WEEKLY_RESET)).toEqual(status(1));
    expect(reloaded.reads()).toBe(0);
    expect(reloaded.cache.peek(CONNECTION, 'a')).toEqual(status(1));

    const late = setup(first.persisted);
    late.clock.now = NOW + RESET_GRANT_CACHE_TTL_MS;
    await late.activate(WEEKLY_RESET);
    expect(late.reads()).toBe(1);
  });

  test('a failed read is not repeated automatically, only on request', async () => {
    const h = setup();
    expect((await h.cache.plan(CONNECTION, 'a', WEEKLY_RESET)).read).toBe(true);
    h.cache.fail(CONNECTION, 'a');
    expect((await h.cache.plan(CONNECTION, 'a', WEEKLY_RESET)).read).toBe(false);
    h.clock.now += RESET_GRANT_CACHE_TTL_MS;
    expect((await h.cache.plan(CONNECTION, 'a', WEEKLY_RESET)).read).toBe(true);
    h.cache.fail(CONNECTION, 'a');
    h.cache.request(CONNECTION, ['a']);
    expect((await h.cache.plan(CONNECTION, 'a', WEEKLY_RESET)).read).toBe(true);
  });

  test('keeps servers and credentials apart', async () => {
    const h = setup();
    await h.activate(WEEKLY_RESET);
    expect((await h.cache.plan(CONNECTION, 'b', WEEKLY_RESET)).read).toBe(true);
    expect((await h.cache.plan('http://other.test', 'a', WEEKLY_RESET)).read).toBe(true);
  });

  test('refresh requests name the credentials by auth index', async () => {
    let notified = 0;
    const unsubscribe = resetGrantCache.subscribe(() => (notified += 1));
    requestResetGrantReads(CONNECTION, [
      { name: 'a.json', auth_index: ' 7 ' },
      { name: 'b.json', authIndex: 8 },
      { name: 'missing.json' },
    ]);
    expect(notified).toBe(1);
    expect((await resetGrantCache.plan(CONNECTION, '7', null)).read).toBe(true);
    expect((await resetGrantCache.plan(CONNECTION, '8', null)).read).toBe(true);
    requestResetGrantReads(CONNECTION, [{ name: 'missing.json' }]);
    expect(notified).toBe(1);
    unsubscribe();
  });

  test('cards key reads on the 7-day reset, not on the quota object', async () => {
    const hook = await Bun.file('src/features/quota/providers/claude/ClaudeResetGrants.tsx').text();
    expect(hook).not.toContain('refreshToken');
    for (const host of ['QuotaCard', 'QuotaLedger']) {
      const source = await Bun.file(`src/features/quota/components/${host}.tsx`).text();
      expect(source).toContain('claudeWeeklyResetAtMs(quota),\n    onRefresh');
    }
  });
});
