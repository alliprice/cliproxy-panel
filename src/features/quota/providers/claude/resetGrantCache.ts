/**
 * Cached Claude reset-grant reads.
 *
 * The cedar_ember read calls the same Anthropic usage endpoint as the quota
 * read, and Anthropic rate-limits it per token. A card reuses a read for
 * RESET_GRANT_CACHE_TTL_MS and reads upstream again only when
 * - nothing fresh is cached (first mount, or the TTL has passed),
 * - the user asked (card refresh, refresh all, or after spending a grant), or
 * - the credential's 7-day reset moved (a new week, or a spent grant).
 * A new quota object, a re-render or a remount alone never reads. A failed
 * read is not repeated automatically inside the TTL; an explicit refresh is.
 *
 * Reads persist in the quota-history IndexedDB, so a reload inside the TTL
 * does not read either.
 */

import type { AnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';
import type { AuthFileItem, ClaudeQuotaState } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { MINUTE_MS } from '@/utils/time/durations';
import {
  readResetGrants,
  saveResetGrants,
  type StoredResetGrants,
} from '../../forecast/quotaHistory';

export const RESET_GRANT_CACHE_TTL_MS = 15 * MINUTE_MS;
/** Header (whole seconds) and JSON (microseconds) readings of one reset differ slightly. */
export const WEEKLY_RESET_TOLERANCE_MS = MINUTE_MS;

/** The 7-day account window's reset instant, or null when the quota has none. */
export function claudeWeeklyResetAtMs(quota: unknown): number | null {
  const windows = (quota as ClaudeQuotaState | undefined)?.windows;
  const resetAtMs = windows?.find((window) => window.id === 'seven-day')?.resetAtMs;
  return typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) ? resetAtMs : null;
}

/** Whether the 7-day reset is a different instant from the one a read was made under. */
export const weeklyResetMoved = (readUnder: number | null, current: number | null): boolean =>
  readUnder !== null &&
  current !== null &&
  Math.abs(readUnder - current) > WEEKLY_RESET_TOLERANCE_MS;

export interface ResetGrantPlan {
  /** Last known grants to show meanwhile (possibly older than the TTL). */
  status: AnthropicResetGrantStatus | null;
  /** Whether to read upstream now. */
  read: boolean;
}

interface ResetGrantCacheDependencies {
  now: () => number;
  load: (connection: string, authIndex: string) => Promise<StoredResetGrants | undefined>;
  save: (record: StoredResetGrants) => Promise<void>;
}

const isStoredRecord = (value: unknown): value is StoredResetGrants => {
  const record = value as StoredResetGrants | undefined;
  return (
    typeof record?.readAt === 'number' &&
    (record.weeklyResetAtMs === null || typeof record.weeklyResetAtMs === 'number') &&
    Array.isArray(record.status?.grants)
  );
};

export function createResetGrantCache(
  deps: ResetGrantCacheDependencies = {
    now: () => Date.now(),
    load: readResetGrants,
    save: saveResetGrants,
  }
) {
  const records = new Map<string, StoredResetGrants>();
  /** Credentials the user asked to read again. */
  const requested = new Set<string>();
  /** When a credential's last read failed. */
  const failedAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  let version = 0;
  const keyOf = (connection: string, authIndex: string) => JSON.stringify([connection, authIndex]);
  const withinTtl = (at: number) => {
    const age = deps.now() - at;
    return age >= 0 && age < RESET_GRANT_CACHE_TTL_MS;
  };

  return {
    /** This tab's last read, for an immediate render. Never decides whether to read. */
    peek(connection: string, authIndex: string): AnthropicResetGrantStatus | null {
      return records.get(keyOf(connection, authIndex))?.status ?? null;
    },

    /** Whether a card should read upstream now, and what to show meanwhile. */
    async plan(
      connection: string,
      authIndex: string,
      weeklyResetAtMs: number | null
    ): Promise<ResetGrantPlan> {
      const key = keyOf(connection, authIndex);
      const known = records.get(key);
      if (!known || !withinTtl(known.readAt)) {
        // A reload, or another tab may have read since.
        const stored = await deps.load(connection, authIndex).catch(() => undefined);
        if (isStoredRecord(stored) && stored.readAt > (records.get(key)?.readAt ?? -Infinity)) {
          records.set(key, stored);
        }
      }
      const record = records.get(key);
      const status = record?.status ?? null;
      if (requested.has(key)) return { status, read: true };
      if (
        record &&
        withinTtl(record.readAt) &&
        !weeklyResetMoved(record.weeklyResetAtMs, weeklyResetAtMs)
      ) {
        return { status, read: false };
      }
      const failure = failedAt.get(key);
      return { status, read: failure === undefined || !withinTtl(failure) };
    },

    /** Records a successful upstream read. */
    store(
      connection: string,
      authIndex: string,
      weeklyResetAtMs: number | null,
      status: AnthropicResetGrantStatus
    ) {
      const key = keyOf(connection, authIndex);
      const record = { connection, authIndex, readAt: deps.now(), weeklyResetAtMs, status };
      records.set(key, record);
      requested.delete(key);
      failedAt.delete(key);
      void deps.save(record).catch(() => undefined);
    },

    /** Records a failed upstream read; only an explicit request retries it inside the TTL. */
    fail(connection: string, authIndex: string) {
      const key = keyOf(connection, authIndex);
      requested.delete(key);
      failedAt.set(key, deps.now());
    },

    /** The next read for these credentials goes upstream; mounted cards re-plan. */
    request(connection: string, authIndexes: readonly string[]) {
      if (authIndexes.length === 0) return;
      authIndexes.forEach((authIndex) => requested.add(keyOf(connection, authIndex)));
      version += 1;
      listeners.forEach((listener) => listener());
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Changes on every request, so subscribed cards re-plan. */
    version: () => version,
  };
}

export type ResetGrantCache = ReturnType<typeof createResetGrantCache>;

export const resetGrantCache = createResetGrantCache();

/** An explicit refresh for these credentials: their next reset-grant read goes upstream. */
export function requestResetGrantReads(connection: string, files: readonly AuthFileItem[]) {
  resetGrantCache.request(
    connection,
    files
      .map((file) => normalizeAuthIndex(file['auth_index'] ?? file.authIndex))
      .filter((authIndex): authIndex is string => authIndex !== null)
  );
}
