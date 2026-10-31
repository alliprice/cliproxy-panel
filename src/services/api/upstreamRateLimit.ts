/**
 * Retry-After backoff for upstream provider reads sent through the
 * Management API's api-call proxy.
 *
 * Anthropic rate-limits its OAuth usage endpoint per token, and a 429 there
 * carries a Retry-After that can be most of an hour. Calling again before it
 * passes only keeps the token locked out, so after a 429 the panel stops
 * calling upstream for that credential until the time has passed.
 *
 * Blocks are kept per connection and auth_index in localStorage, so a reload
 * or another tab respects them. Without localStorage (private mode, tests)
 * they live in memory for the tab.
 */

import type { AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/useAuthStore';
import { browserLocalStorage, createSharedRecord } from '@/services/storage/sharedRecord';
import { isRecord } from '@/utils/helpers';
import { MINUTE_MS, HOUR_MS } from '@/utils/time/durations';
import { apiCallApi, type ApiCallRequest, type ApiCallResult } from './apiCall';

/** Wait used when a 429 carries no usable Retry-After. */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * MINUTE_MS;
/** A 429 with `Retry-After: 0` still waits this long: retrying at once extends the limit. */
export const MIN_RATE_LIMIT_BACKOFF_MS = MINUTE_MS;
/** Caps a far-future HTTP-date so one bad header cannot block a credential for days. */
export const MAX_RATE_LIMIT_BACKOFF_MS = 24 * HOUR_MS;

export const RATE_LIMIT_STORAGE_KEY = 'quota.rateLimitedUntil';

/** A call skipped because its credential is still inside a Retry-After window. */
export class UpstreamRateLimitedError extends Error {
  readonly status = 429;

  constructor(readonly until: number) {
    super(`Upstream rate limited until ${new Date(until).toISOString()}`);
    this.name = 'UpstreamRateLimitedError';
  }
}

/**
 * Milliseconds to wait from `nowMs`, read from a Retry-After header given as
 * delay-seconds or an HTTP-date. Null when the header is missing or unusable.
 */
export function parseRetryAfterMs(header: unknown, nowMs: number): number | null {
  if (!isRecord(header)) return null;
  const name = Object.keys(header).find((key) => key.toLowerCase() === 'retry-after');
  if (!name) return null;
  const raw = header[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  // An HTTP-date always names a weekday or month; this keeps bare numbers such
  // as "-5" from being read as a year.
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** The wait the panel applies for a parsed Retry-After (null: none was usable). */
export const rateLimitBackoffMs = (retryAfterMs: number | null): number =>
  retryAfterMs === null
    ? DEFAULT_RATE_LIMIT_BACKOFF_MS
    : Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, retryAfterMs));

interface RateLimitDependencies {
  now: () => number;
  /** Connected server; keeps two backends' auth indexes apart. */
  connection: () => string;
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

const defaultDependencies: RateLimitDependencies = {
  now: () => Date.now(),
  connection: () => useAuthStore.getState().apiBase,
  storage: browserLocalStorage,
};

const finiteNumbers = (value: unknown): Record<string, number> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' && Number.isFinite(entry[1])
        )
      )
    : {};

export function createUpstreamRateLimits(deps: RateLimitDependencies = defaultDependencies) {
  const blocks = createSharedRecord<number>({
    key: RATE_LIMIT_STORAGE_KEY,
    sanitize: finiteNumbers,
    storage: deps.storage,
    crossTab: deps === defaultDependencies,
  });
  const keyOf = (authIndex: string) => `${deps.connection()}|${authIndex}`;

  return {
    /** Stored block end for a credential, even when already past (stable for subscribers). */
    storedUntil(authIndex: string): number | null {
      return blocks.read()[keyOf(authIndex)] ?? null;
    },
    /** End of the credential's block, or null when it may call upstream. */
    blockedUntil(authIndex: string): number | null {
      const until = blocks.read()[keyOf(authIndex)];
      return until !== undefined && until > deps.now() ? until : null;
    },
    /** Records a 429 and returns when the credential may call upstream again. */
    record(authIndex: string, header: unknown): number {
      const now = deps.now();
      const until = now + rateLimitBackoffMs(parseRetryAfterMs(header, now));
      const key = keyOf(authIndex);
      const current = blocks.read();
      if ((current[key] ?? 0) >= until) return current[key];
      // Drop blocks that have ended so the stored record stays small.
      const next = Object.fromEntries(Object.entries(current).filter(([, value]) => value > now));
      next[key] = until;
      blocks.write(next);
      return until;
    },
    subscribe: blocks.subscribe,
    clear: blocks.clear,
  };
}

export type UpstreamRateLimits = ReturnType<typeof createUpstreamRateLimits>;

export const upstreamRateLimits = createUpstreamRateLimits();

/**
 * `apiCallApi.request` behind the credential's Retry-After block: refuses
 * without a network call while blocked, and records the block a 429 asks for.
 */
export async function requestUpstream(
  request: ApiCallRequest,
  config?: AxiosRequestConfig,
  limits: UpstreamRateLimits = upstreamRateLimits
): Promise<ApiCallResult> {
  const authIndex = request.authIndex;
  if (authIndex) {
    const until = limits.blockedUntil(authIndex);
    if (until !== null) throw new UpstreamRateLimitedError(until);
  }
  const result = await apiCallApi.request(request, config);
  if (result.statusCode === 429 && authIndex) limits.record(authIndex, result.header);
  return result;
}
