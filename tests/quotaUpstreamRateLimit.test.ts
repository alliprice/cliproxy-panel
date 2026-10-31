/**
 * Retry-After backoff for Claude and Codex upstream reads made through the
 * Management API's api-call proxy.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import i18n from '@/i18n';
import { apiCallApi, type ApiCallRequest, type ApiCallResult } from '@/services/api/apiCall';
import {
  claimClaudeResetGrant,
  readClaudeOrganization,
  readClaudeResetGrants,
} from '@/services/api/claudeResetGrants';
import {
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
  MIN_RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_STORAGE_KEY,
  UpstreamRateLimitedError,
  createUpstreamRateLimits,
  parseRetryAfterMs,
  rateLimitBackoffMs,
  requestUpstream,
  upstreamRateLimits,
} from '@/services/api/upstreamRateLimit';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { formatRateLimitedUntil, quotaRateLimitedUntil } from '@/features/quota/rateLimit';
import { CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL, CODEX_USAGE_URL } from '@/utils/quota';
import { getStatusFromError } from '@/utils/quota';
import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const t = i18n.cloneInstance({ lng: 'en' }).t;
const claudeFile = { name: 'claude-limited.json', type: 'claude', auth_index: 'claude-index' };
const codexFile = { name: 'codex-limited.json', type: 'codex', auth_index: 'codex-index' };
const result = (
  statusCode: number,
  body: unknown,
  header: Record<string, string[]> = {}
): ApiCallResult => ({ statusCode, header, body, bodyText: JSON.stringify(body) });

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
};

const originalRequest = apiCallApi.request;
afterEach(() => {
  apiCallApi.request = originalRequest;
  upstreamRateLimits.clear();
});

/** Records every proxied call; answers each with `respond`. */
const recordCalls = (respond: (request: ApiCallRequest) => ApiCallResult) => {
  const calls: ApiCallRequest[] = [];
  apiCallApi.request = async (request) => {
    calls.push(request);
    return respond(request);
  };
  return calls;
};

describe('Retry-After parsing', () => {
  test('reads delay-seconds under any header-name case', () => {
    expect(parseRetryAfterMs({ 'Retry-After': ['2600'] }, NOW)).toBe(2_600_000);
    expect(parseRetryAfterMs({ 'retry-after': ['30'] }, NOW)).toBe(30_000);
    expect(parseRetryAfterMs({ 'RETRY-AFTER': '1.5' }, NOW)).toBe(1500);
    expect(parseRetryAfterMs({ 'Retry-After': ['0'] }, NOW)).toBe(0);
  });

  test('reads an HTTP-date relative to now, and a past date as no wait', () => {
    expect(parseRetryAfterMs({ 'Retry-After': ['Sat, 31 Oct 2026 12:43:20 GMT'] }, NOW)).toBe(
      2_600_000
    );
    expect(parseRetryAfterMs({ 'Retry-After': ['Sat, 31 Oct 2026 11:00:00 GMT'] }, NOW)).toBe(0);
  });

  test('is null when missing or unusable', () => {
    expect(parseRetryAfterMs({}, NOW)).toBeNull();
    expect(parseRetryAfterMs(undefined, NOW)).toBeNull();
    expect(parseRetryAfterMs({ 'Content-Type': ['application/json'] }, NOW)).toBeNull();
    expect(parseRetryAfterMs({ 'Retry-After': [] }, NOW)).toBeNull();
    expect(parseRetryAfterMs({ 'Retry-After': ['soon'] }, NOW)).toBeNull();
    expect(parseRetryAfterMs({ 'Retry-After': ['-5'] }, NOW)).toBeNull();
  });

  test('backoff: a default without a header, a floor for zero, a cap for far dates', () => {
    expect(rateLimitBackoffMs(null)).toBe(DEFAULT_RATE_LIMIT_BACKOFF_MS);
    expect(DEFAULT_RATE_LIMIT_BACKOFF_MS).toBe(15 * MINUTE_MS);
    expect(rateLimitBackoffMs(0)).toBe(MIN_RATE_LIMIT_BACKOFF_MS);
    expect(rateLimitBackoffMs(2_600_000)).toBe(2_600_000);
    expect(rateLimitBackoffMs(30 * 24 * HOUR_MS)).toBe(MAX_RATE_LIMIT_BACKOFF_MS);
  });
});

describe('blocked-until store', () => {
  const create = (storage: ReturnType<typeof memoryStorage> | null, clock = { now: NOW }) =>
    createUpstreamRateLimits({
      now: () => clock.now,
      connection: () => 'http://panel.test',
      storage: () => storage,
    });

  test('blocks the credential for Retry-After and persists across reloads and tabs', () => {
    const storage = memoryStorage();
    const clock = { now: NOW };
    const limits = create(storage, clock);
    expect(limits.record('a', { 'Retry-After': ['2600'] })).toBe(NOW + 2_600_000);
    expect(limits.blockedUntil('a')).toBe(NOW + 2_600_000);
    expect(limits.blockedUntil('b')).toBeNull();
    expect(JSON.parse(storage.items.get(RATE_LIMIT_STORAGE_KEY)!)).toEqual({
      'http://panel.test|a': NOW + 2_600_000,
    });

    // A reloaded page or another tab reads the same storage.
    const reloaded = create(storage, clock);
    expect(reloaded.blockedUntil('a')).toBe(NOW + 2_600_000);

    clock.now = NOW + 2_600_000;
    expect(reloaded.blockedUntil('a')).toBeNull();
  });

  test('uses the default without Retry-After and never shortens a running block', () => {
    const limits = create(memoryStorage());
    expect(limits.record('a', {})).toBe(NOW + DEFAULT_RATE_LIMIT_BACKOFF_MS);
    expect(limits.record('a', { 'Retry-After': ['60'] })).toBe(NOW + DEFAULT_RATE_LIMIT_BACKOFF_MS);
  });

  test('keeps working in memory without storage, and notifies subscribers', () => {
    const limits = create(null);
    let notified = 0;
    const unsubscribe = limits.subscribe(() => (notified += 1));
    limits.record('a', { 'Retry-After': ['120'] });
    expect(limits.blockedUntil('a')).toBe(NOW + 120_000);
    expect(notified).toBe(1);
    unsubscribe();
    limits.clear();
    expect(limits.blockedUntil('a')).toBeNull();
    expect(notified).toBe(1);
  });

  test('keeps two servers apart', () => {
    const storage = memoryStorage();
    let connection = 'http://one.test';
    const limits = createUpstreamRateLimits({
      now: () => NOW,
      connection: () => connection,
      storage: () => storage,
    });
    limits.record('a', { 'Retry-After': ['120'] });
    connection = 'http://two.test';
    expect(limits.blockedUntil('a')).toBeNull();
  });
});

describe('requestUpstream', () => {
  test('records a 429 and refuses the next call without sending it', async () => {
    const calls = recordCalls(() => result(429, null, { 'Retry-After': ['2600'] }));
    const request = { authIndex: 'a', method: 'GET', url: CLAUDE_USAGE_URL };
    expect((await requestUpstream(request)).statusCode).toBe(429);
    const until = upstreamRateLimits.blockedUntil('a');
    expect(until).not.toBeNull();
    await expect(requestUpstream(request)).rejects.toBeInstanceOf(UpstreamRateLimitedError);
    await expect(requestUpstream(request)).rejects.toMatchObject({ status: 429, until });
    expect(calls).toHaveLength(1);
  });
});

describe('quota reads inside a Retry-After window', () => {
  test('a Claude usage 429 blocks the credential; the next read sends nothing', async () => {
    const calls = recordCalls((request) =>
      request.url === CLAUDE_USAGE_URL
        ? result(429, { error: { message: 'Rate limited.' } }, { 'Retry-After': ['2600'] })
        : result(200, {})
    );
    await expect(CLAUDE_CONFIG.fetchQuota(claudeFile, t)).rejects.toThrow('429');
    expect(calls.map((call) => call.url).sort()).toEqual([CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL]);
    const until = quotaRateLimitedUntil('claude', claudeFile);
    expect(until).toBeGreaterThan(Date.now() + 2_590_000);

    calls.length = 0;
    try {
      await CLAUDE_CONFIG.fetchQuota(claudeFile, t);
      throw new Error('a blocked read must not succeed');
    } catch (error) {
      expect(getStatusFromError(error)).toBe(429);
      expect((error as Error).message).toBe(formatRateLimitedUntil(t, until!));
    }
    expect(calls).toHaveLength(0);
  });

  test('blocked usage, profile, and reset-grant reads send nothing', async () => {
    upstreamRateLimits.record('claude-index', { 'Retry-After': ['600'] });
    const calls = recordCalls(() => result(200, {}));
    await expect(CLAUDE_CONFIG.fetchQuota(claudeFile, t)).rejects.toMatchObject({ status: 429 });
    for (const read of [readClaudeResetGrants, readClaudeOrganization]) {
      await expect(read('claude-index')).rejects.toMatchObject({ code: 'rate_limited' });
    }
    expect(calls).toHaveLength(0);
  });

  test('a blocked claim is refused before sending, which spends nothing', async () => {
    upstreamRateLimits.record('claude-index', {});
    const calls = recordCalls(() => result(200, { result: 'reset' }));
    expect(
      await claimClaudeResetGrant(
        'claude-index',
        '11111111-2222-3333-4444-555555555555',
        'grant',
        'request'
      )
    ).toBe('rate_limited');
    expect(calls).toHaveLength(0);
  });

  test('a reset-grant 429 blocks the quota reads of the same credential', async () => {
    const calls = recordCalls(() => result(429, null, { 'Retry-After': ['60'] }));
    await expect(readClaudeResetGrants('claude-index')).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await expect(CLAUDE_CONFIG.fetchQuota(claudeFile, t)).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });

  test('a Codex usage 429 with an HTTP-date blocks every Codex read for the credential', async () => {
    const retryAt = new Date(Date.now() + HOUR_MS);
    const calls = recordCalls((request) =>
      request.url === CODEX_USAGE_URL
        ? result(429, null, { 'Retry-After': [retryAt.toUTCString()] })
        : result(200, {})
    );
    await expect(CODEX_CONFIG.fetchQuota(codexFile, t)).rejects.toMatchObject({ status: 429 });
    const until = quotaRateLimitedUntil('codex', codexFile)!;
    expect(Math.abs(until - retryAt.getTime())).toBeLessThan(1000);
    expect(quotaRateLimitedUntil('claude', claudeFile)).toBeNull();

    calls.length = 0;
    await expect(CODEX_CONFIG.fetchQuota(codexFile, t)).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(0);
  });

  test('only Claude and Codex credentials are gated', () => {
    upstreamRateLimits.record('shared-index', {});
    const file = { name: 'kimi.json', type: 'kimi', auth_index: 'shared-index' };
    expect(quotaRateLimitedUntil('kimi', file)).toBeNull();
    expect(quotaRateLimitedUntil('claude', file)).not.toBeNull();
  });
});

describe('rate-limit notice', () => {
  test('names the clock time today and the weekday on a later day', () => {
    const today = new Date(2026, 9, 31, 9, 0).getTime();
    expect(formatRateLimitedUntil(t, new Date(2026, 9, 31, 15, 5).getTime(), today, 'en')).toBe(
      'Rate limited until 3:05 PM'
    );
    expect(formatRateLimitedUntil(t, new Date(2026, 10, 1, 9, 30).getTime(), today, 'en')).toBe(
      'Rate limited until Sun 9:30 AM'
    );
  });

  test('is translated in all six locales', async () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      expect(messages.quota_management.rate_limited_until).toContain('{{time}}');
    }
  });
});
