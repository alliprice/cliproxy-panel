/**
 * Which quota reads sit behind the upstream Retry-After backoff, and how the
 * block reads on screen. React-free so provider data modules can use it.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import { upstreamRateLimits } from '@/services/api/upstreamRateLimit';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { createStatusError } from '@/utils/quota';
import { READING_AGE_NOTE_MS } from './constants';
import { formatClockOrWeekday } from './display';
import { claudeUsageUnavailable } from './providers/claude/usageScope';
import type { QuotaProviderType } from './providers/types';

/** Providers whose quota reads record and respect Retry-After. */
export const RATE_LIMITED_QUOTA_PROVIDERS: readonly QuotaProviderType[] = ['claude', 'codex'];

const authIndexOf = (file: AuthFileItem) =>
  normalizeAuthIndex(file['auth_index'] ?? file.authIndex);

/** Stored block end for the credential (possibly past), or null. Stable between writes. */
export function quotaRateLimitStoredUntil(
  provider: QuotaProviderType,
  file: AuthFileItem
): number | null {
  if (!RATE_LIMITED_QUOTA_PROVIDERS.includes(provider)) return null;
  const authIndex = authIndexOf(file);
  return authIndex ? upstreamRateLimits.storedUntil(authIndex) : null;
}

/** When the credential may call upstream again, or null when it may now. */
export function quotaRateLimitedUntil(
  provider: QuotaProviderType,
  file: AuthFileItem
): number | null {
  if (!RATE_LIMITED_QUOTA_PROVIDERS.includes(provider)) return null;
  const authIndex = authIndexOf(file);
  return authIndex ? upstreamRateLimits.blockedUntil(authIndex) : null;
}

/**
 * Whether automatic reads skip the credential: it is inside a Retry-After
 * window, or it is a Claude setup token that cannot read usage.
 */
export const quotaReadBlocked = (provider: QuotaProviderType, file: AuthFileItem): boolean =>
  quotaRateLimitedUntil(provider, file) !== null ||
  (provider === 'claude' && claudeUsageUnavailable(file));

/**
 * `Usage check paused until 3:05 PM`: the panel's own usage reads wait out a
 * 429. It says nothing about whether CLIProxyAPI routes to the credential.
 */
export function formatUsageCheckPaused(
  t: TFunction,
  until: number,
  nowMs = Date.now(),
  language?: string
): string {
  return t('quota_management.usage_check_paused_until', {
    time: formatClockOrWeekday(until, nowMs, language),
  });
}

/** The error a read refused by the backoff fails with (status 429, nothing was sent). */
export const rateLimitedQuotaError = (t: TFunction, until: number) =>
  createStatusError(formatUsageCheckPaused(t, until), 429);

/**
 * Secondary notes about the panel's own readings of a credential, never about
 * routing: its usage check is paused or impossible, or its reading is old.
 */
export function readingNotes(
  t: TFunction,
  readings: {
    usageUnavailable: boolean;
    usageCheckPausedUntil: number | null;
    /** When the shown reading was taken upstream. */
    observedAtMs: number | null;
  },
  nowMs: number,
  language?: string
): string[] {
  const notes: string[] = [];
  if (readings.usageUnavailable) notes.push(t('claude_quota.usage_scope_missing'));
  else if (readings.usageCheckPausedUntil !== null) {
    notes.push(formatUsageCheckPaused(t, readings.usageCheckPausedUntil, nowMs, language));
  }
  const observedAtMs = readings.observedAtMs;
  if (observedAtMs !== null && nowMs - observedAtMs > READING_AGE_NOTE_MS) {
    notes.push(
      t('quota_management.reading_as_of', {
        time: formatClockOrWeekday(observedAtMs, nowMs, language),
      })
    );
  }
  return notes;
}
