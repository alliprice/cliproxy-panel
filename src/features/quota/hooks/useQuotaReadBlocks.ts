/**
 * Why a credential's quota reads are paused, live across tabs and reloads.
 */

import { useSyncExternalStore } from 'react';
import type { AuthFileItem } from '@/types';
import { upstreamRateLimits } from '@/services/api/upstreamRateLimit';
import { claudeUsageScope, claudeUsageUnavailable } from '../providers/claude/usageScope';
import { quotaRateLimitStoredUntil } from '../rateLimit';
import type { QuotaProviderType } from '../providers/types';

/** When the credential's quota reads resume, or null when they are not blocked at `nowMs`. */
export function useQuotaRateLimitedUntil(
  provider: QuotaProviderType,
  file: AuthFileItem,
  nowMs: number
): number | null {
  const snapshot = () => quotaRateLimitStoredUntil(provider, file);
  const until = useSyncExternalStore(upstreamRateLimits.subscribe, snapshot, snapshot);
  return until !== null && until > nowMs ? until : null;
}

/** Whether the credential is a Claude setup token that cannot read usage. */
export function useClaudeUsageUnavailable(provider: QuotaProviderType, file: AuthFileItem) {
  const snapshot = () => provider === 'claude' && claudeUsageUnavailable(file);
  return useSyncExternalStore(claudeUsageScope.subscribe, snapshot, snapshot);
}
