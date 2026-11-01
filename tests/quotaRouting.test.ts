/**
 * Which credential CLIProxyAPI routes to, read from the auth-files listing in
 * the shapes the live server returns, and what the quota page says about it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import i18n from '@/i18n';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import { upstreamRateLimits } from '@/services/api/upstreamRateLimit';
import { buildQuotaForecast } from '@/features/quota/forecast/forecastModel';
import { passiveQuotaFor } from '@/features/quota/forecast/passiveQuota';
import { readQuotaMeters } from '@/features/quota/forecast/quotaMeters';
import { formatClockOrWeekday } from '@/features/quota/display';
import { readingNotes } from '@/features/quota/rateLimit';
import {
  credentialRoutingStatus,
  formatOutUntil,
  outUntilFor,
  partitionForForecast,
  routingText,
} from '@/features/quota/routing';
import type { AuthFileItem } from '@/types';
import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';

const t = i18n.cloneInstance({ lng: 'en' }).t;
/** The listing arrived at 01:06:29Z; times below follow the live listing. */
const NOW = Date.parse('2026-11-01T01:06:29Z');
const FIVE_HOUR_RESET = Date.parse('2026-11-01T01:10:00Z');
const WEEKLY_RESET = Date.parse('2026-11-04T14:00:00Z');
const unix = (ms: number) => String(Math.round(ms / 1000));
const time = (ms: number) => formatClockOrWeekday(ms, NOW, 'en');
const buckets = (successes: number[], failed: number[] = []) =>
  successes.map((success, index) => ({
    time: `bucket-${index}`,
    success,
    failed: failed[index] ?? 0,
  }));

/** A Claude credential benched by CLIProxyAPI after its 5-hour window ran out. */
const benched = {
  name: 'benched.json',
  type: 'claude',
  auth_index: 'benched-index',
  priority: 1,
  status: 'error',
  unavailable: true,
  status_message:
    '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
  cooldowns: [
    {
      scope: 'credential',
      reason: 'credential_quota',
      retry_at: '2026-11-01T01:10:20.00183Z',
      remaining_seconds: 231,
    },
    {
      scope: 'model',
      model_key: 'claude-opus',
      reason: 'credential_quota',
      retry_at: '2026-11-01T01:10:20Z',
      remaining_seconds: 231,
      http_status: 429,
    },
    {
      scope: 'model',
      model_key: 'claude-sonnet',
      reason: 'quota',
      retry_at: '2026-11-01T01:09:00Z',
      remaining_seconds: 151,
      http_status: 429,
    },
  ],
  recent_requests: buckets([0, 0, 0, 0], [0, 0, 3, 2]),
  quota: {
    observed_at: '2026-11-01T00:11:37.123456789Z',
    signals: {
      'Anthropic-Ratelimit-Unified-5h-Utilization': '0.97',
      'Anthropic-Ratelimit-Unified-5h-Reset': unix(FIVE_HOUR_RESET),
      'Anthropic-Ratelimit-Unified-7d-Utilization': '0.41',
      'Anthropic-Ratelimit-Unified-7d-Reset': unix(WEEKLY_RESET),
      'Anthropic-Ratelimit-Unified-Status': 'allowed_warning',
    },
  },
};

/** The credential carrying the traffic meanwhile. */
const busy = {
  name: 'busy.json',
  type: 'claude',
  auth_index: 'busy-index',
  priority: null,
  status: 'active',
  unavailable: false,
  cooldowns: [],
  recent_requests: buckets([184, 125, 61, 78]),
  quota: {
    observed_at: '2026-11-01T01:06:28Z',
    signals: {
      'Anthropic-Ratelimit-Unified-5h-Utilization': '0.35',
      'Anthropic-Ratelimit-Unified-5h-Reset': unix(NOW + 3 * 60 * MINUTE_MS),
      'Anthropic-Ratelimit-Unified-7d-Utilization': '0.20',
      'Anthropic-Ratelimit-Unified-7d-Reset': unix(NOW + 2 * DAY_MS),
    },
  },
};

const listed = (...entries: Record<string, unknown>[]): AuthFileItem[] =>
  normalizeAuthFilesResponse({ files: entries as AuthFileItem[] }, NOW).files;
const metersOf = (file: AuthFileItem) =>
  readQuotaMeters('claude', passiveQuotaFor('claude', file, t)?.state);
const statusOf = (entry: Record<string, unknown>, nowMs = NOW) => {
  const [file] = listed(entry);
  return credentialRoutingStatus(file, metersOf(file), nowMs);
};

afterEach(() => upstreamRateLimits.clear());

describe('routing status from the listing', () => {
  test('a credential-wide cooldown is cooling, named by the window it emptied', () => {
    const status = statusOf(benched);
    expect(status).toMatchObject({
      state: 'cooling',
      cooldown: {
        untilMs: NOW + 231_000,
        reason: 'credential_quota',
        limit: 'five_hour',
        meterId: 'five-hour',
      },
      // Model timers inside a credential cooldown add nothing.
      models: null,
      priority: 1,
      recentRequests: 2,
    });
    expect(routingText(t, status, NOW, 'en')).toEqual({
      state: `Cooling down until ${time(NOW + 231_000)}`,
      details: ['5-hour limit reached', '2 req in 10 min', 'Priority 1'],
      models: null,
    });
  });

  test('successes in the newest two buckets are serving', () => {
    const status = statusOf(busy);
    expect(status).toMatchObject({ state: 'serving', cooldown: null, priority: null });
    expect(routingText(t, status, NOW, 'en')).toEqual({
      state: 'Serving',
      details: ['78 req in 10 min'],
      models: null,
    });
    expect(statusOf({ ...busy, recent_requests: buckets([5, 0, 4, 0]) }).state).toBe('serving');
    expect(statusOf({ ...busy, recent_requests: buckets([90, 40, 0, 0]) }).state).toBe('standby');
  });

  test('available with no recent successes is standby; switched off is disabled', () => {
    expect(statusOf({ ...busy, recent_requests: [] }).state).toBe('standby');
    expect(routingText(t, statusOf({ ...busy, recent_requests: [] }), NOW).state).toBe('Standby');
    const disabled = statusOf({ ...benched, disabled: true });
    expect(disabled.state).toBe('disabled');
    expect(routingText(t, disabled, NOW).state).toBe('Disabled');
  });

  test('model-only cooldowns are a secondary line on a credential that still serves', () => {
    const status = statusOf({
      ...busy,
      cooldowns: benched.cooldowns.filter((cooldown) => cooldown.scope === 'model'),
    });
    expect(status.state).toBe('serving');
    expect(status.models).toEqual({ count: 2, untilMs: NOW + 231_000 });
    expect(routingText(t, status, NOW, 'en').models).toBe(
      `2 models cooling down until ${time(NOW + 231_000)}`
    );
  });
});

describe('naming the limit behind a cooldown', () => {
  const credential = (retryAt: string, extra: Record<string, unknown> = {}) => ({
    ...benched,
    cooldowns: [
      {
        scope: 'credential',
        reason: 'credential_quota',
        retry_at: retryAt,
        remaining_seconds: 600,
      },
    ],
    ...extra,
  });

  test('retry_at at the weekly reset is the weekly limit', () => {
    expect(statusOf(credential('2026-11-04T14:02:00Z')).cooldown).toMatchObject({
      limit: 'weekly',
      meterId: 'seven-day',
    });
  });

  test('the representative claim names the 5-hour window when retry_at matches nothing', () => {
    const claimed = credential('2026-11-01T03:00:00Z', {
      quota: {
        ...benched.quota,
        signals: {
          ...benched.quota.signals,
          'Anthropic-Ratelimit-Unified-5h-Utilization': '0.5',
          'Anthropic-Ratelimit-Unified-Representative-Claim': 'five_hour',
        },
      },
    });
    expect(statusOf(claimed).cooldown).toMatchObject({ limit: 'five_hour', meterId: 'five-hour' });
  });

  test('a reading near the limit names it without claiming a window', () => {
    expect(statusOf(credential('2026-11-01T03:00:00Z')).cooldown).toMatchObject({
      limit: 'five_hour',
      meterId: null,
    });
  });

  test('otherwise "rate limited", or the cooldown reason', () => {
    const low = {
      quota: {
        ...benched.quota,
        signals: { ...benched.quota.signals, 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.2' },
      },
    };
    const limited = statusOf(credential('2026-11-01T03:00:00Z', low));
    expect(limited.cooldown?.limit).toBe('rate_limited');
    expect(routingText(t, limited, NOW).details[0]).toBe('Rate limited');

    const refused = statusOf({
      ...credential('2026-11-01T03:00:00Z', low),
      cooldowns: [
        {
          scope: 'credential',
          reason: 'unauthorized',
          retry_at: '2026-11-01T03:00:00Z',
          remaining_seconds: 600,
        },
      ],
    });
    expect(refused.cooldown?.limit).toBe('other');
    expect(routingText(t, refused, NOW).details[0]).toBe('Unauthorized');
  });

  test('unavailable without a timer is cooling with no end time', () => {
    const status = statusOf({ ...benched, cooldowns: [] });
    expect(status.cooldown).toMatchObject({ untilMs: null, limit: 'five_hour' });
    expect(routingText(t, status, NOW).state).toBe('Cooling down');
  });
});

describe('out until the cooldown ends', () => {
  test('the emptied window says when it is back, and only that window', () => {
    const status = statusOf(benched);
    expect(outUntilFor(status, 'five-hour')).toBe(NOW + 231_000);
    expect(outUntilFor(status, 'seven-day')).toBeNull();
    expect(formatOutUntil(t, NOW + 231_000, NOW, 'en')).toBe(
      `Out until ${time(NOW + 231_000)} (limit reached)`
    );
  });

  test('clears once the cooldown has run out, before the next listing arrives', () => {
    const after = statusOf(benched, NOW + 232_000);
    expect(after.state).toBe('standby');
    expect(after.cooldown).toBeNull();
    expect(outUntilFor(after, 'five-hour')).toBeNull();
  });

  test('the provider summary leaves the cooling credential out and names it', () => {
    const entries = listed(benched, busy).map((file) => ({ file }));
    const { usable, out } = partitionForForecast(entries, (entry) => metersOf(entry.file), NOW);
    expect(usable.map((entry) => entry.file.name)).toEqual(['busy.json']);
    expect(out).toEqual([{ entry: entries[0], untilMs: NOW + 231_000 }]);

    const session = (files: { file: AuthFileItem }[]) =>
      buildQuotaForecast({
        live: files.map(({ file }) => {
          const meter = metersOf(file).find((item) => item.id === 'five-hour')!;
          return {
            credentialId: file.name,
            remaining: meter.remaining,
            resetAtMs: meter.resetAtMs,
            periodHours: meter.periodHours,
            ratePerHour: null,
            averagePerHour: null,
          };
        }),
        history: [],
        nowMs: NOW,
        rangeMs: DAY_MS,
        lookbackMs: 5 * 60 * MINUTE_MS,
        enoughMs: 30 * MINUTE_MS,
      });
    // The frozen 3% no longer counts as capacity.
    expect(session(usable)).toMatchObject({ capacity: 100, remaining: 65 });

    const later = partitionForForecast(entries, (entry) => metersOf(entry.file), NOW + 232_000);
    expect(later.out).toEqual([]);
  });
});

describe('usage-check notes stay apart from routing', () => {
  test('a paused usage check never changes what the routing line says', () => {
    const [file] = listed(busy);
    const until = upstreamRateLimits.record('busy-index', { 'Retry-After': ['120'] });
    const status = credentialRoutingStatus(file, metersOf(file), NOW);
    expect(routingText(t, status, NOW, 'en').state).toBe('Serving');
    expect(
      readingNotes(
        t,
        { usageUnavailable: false, usageCheckPausedUntil: until, observedAtMs: NOW },
        NOW,
        'en'
      )
    ).toEqual([`Usage check paused until ${time(until)}`]);
  });

  test('a setup token says its usage is not readable, without an error', () => {
    expect(
      readingNotes(
        t,
        { usageUnavailable: true, usageCheckPausedUntil: NOW + MINUTE_MS, observedAtMs: null },
        NOW
      )
    ).toEqual(['Setup token: live usage not readable']);
  });

  test('a reading older than 5 minutes says when it was taken', () => {
    const observed = Date.parse(benched.quota.observed_at.replace(/(\.\d{3})\d+/, '$1'));
    const notes = (observedAtMs: number) =>
      readingNotes(
        t,
        { usageUnavailable: false, usageCheckPausedUntil: null, observedAtMs },
        NOW,
        'en'
      );
    expect(notes(observed)).toEqual([`as of ${time(observed)}`]);
    expect(notes(NOW - 4 * MINUTE_MS)).toEqual([]);
  });
});

test('routing and note strings exist in all six locales', async () => {
  const keys = [
    'routing_serving',
    'routing_standby',
    'routing_disabled',
    'routing_cooling',
    'routing_cooling_until',
    'routing_limit_five_hour',
    'routing_limit_weekly',
    'routing_limit_rate_limited',
    'routing_requests',
    'routing_priority',
    'routing_models_until',
    'out_until',
    'forecast_out_until',
    'forecast_out',
    'reading_as_of',
    'usage_check_paused_until',
  ];
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
    const messages = (await Bun.file(`src/i18n/locales/${locale}.json`).json()).quota_management;
    for (const key of keys) expect(typeof messages[key]).toBe('string');
    expect(messages.out_until).toContain('{{time}}');
    expect(messages.routing_requests).toContain('{{requests}}');
  }
});
