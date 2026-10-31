/**
 * Which quota reads sit behind the upstream Retry-After backoff, and how the
 * block reads on screen. React-free so provider data modules can use it.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import { upstreamRateLimits } from '@/services/api/upstreamRateLimit';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { createStatusError } from '@/utils/quota';
import { formatClockTime, formatWeekdayTime } from './display';
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

/** `Rate limited until 3:05 PM`; a block that ends on a later day names the weekday. */
export function formatRateLimitedUntil(
  t: TFunction,
  until: number,
  nowMs = Date.now(),
  language?: string
): string {
  const sameDay = new Date(until).toDateString() === new Date(nowMs).toDateString();
  return t('quota_management.rate_limited_until', {
    time: sameDay ? formatClockTime(until, language) : formatWeekdayTime(until, language),
  });
}

/** The error a read refused by the backoff fails with (status 429, nothing was sent). */
export const rateLimitedQuotaError = (t: TFunction, until: number) =>
  createStatusError(formatRateLimitedUntil(t, until), 429);
