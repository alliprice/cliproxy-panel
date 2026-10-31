import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import {
  AnthropicResetGrantError,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import {
  resetGrantOperations,
  RETRY_WINDOW_MS,
  ResetGrantPreflightError,
  resetGrantFailureMessageKey,
} from './resetGrantOperations';
import { plainIdentity, usePrivacyRevealed } from '../../privacy';
import { selectResetGrant } from './selectResetGrant';
import { readResetGrantsForCard, scheduleResetGrantRead } from './resetGrantReads';
import { resetGrantCache } from './resetGrantCache';

/**
 * Card-owned reads; the session-scoped journal owns spending and ambiguous retries.
 * `weeklyResetAtMs` is the credential's 7-day reset (see claudeWeeklyResetAtMs):
 * reads follow resetGrantCache, never the identity of the quota state.
 */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  weeklyResetAtMs: number | null,
  onRefresh: () => void
) {
  const { t } = useTranslation();
  const revealNames = usePrivacyRevealed();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const connection = useAuthStore((state) => state.apiBase);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  // Bumped by explicit refreshes; each card then re-plans against the cache.
  const requests = useSyncExternalStore(
    resetGrantCache.subscribe,
    resetGrantCache.version,
    resetGrantCache.version
  );
  const [status, setStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setStatus(authIndex ? resetGrantCache.peek(connection, authIndex) : null);
    if (!enabled || disabled || !sessionActive || !authIndex) return;
    let cancelled = false;
    let cancelRead = () => {};
    const current = () =>
      !cancelled && version === generation.current && session === apiClient.getConnectionRevision();
    // Whether an upstream read is due now; when not, the cached grants are shown.
    const due = async () => {
      const plan = await resetGrantCache.plan(connection, authIndex, weeklyResetAtMs);
      if (!current()) return false;
      if (plan.status) setStatus(plan.status);
      if (!plan.read) {
        if (plan.status) setMessage('');
        return false;
      }
      return true;
    };
    const read = () =>
      readResetGrantsForCard(authIndex).then(
        (result) => {
          resetGrantCache.store(connection, authIndex, weeklyResetAtMs, result);
          if (current()) {
            setStatus(result);
            setMessage('');
          }
        },
        (error: unknown) => {
          resetGrantCache.fail(connection, authIndex);
          if (current()) {
            setMessage(
              error instanceof AnthropicResetGrantError && error.code === 'rate_limited'
                ? 'rate_limited'
                : 'read_error'
            );
          }
        }
      );
    void due().then((first) => {
      if (!first || !current()) return;
      // Planned again after the delay: another activation's read may have landed meanwhile.
      cancelRead = scheduleResetGrantRead(() => {
        void due().then((still) => {
          if (still) void read();
        });
      }, current);
    });
    return () => {
      cancelled = true;
      cancelRead();
      generation.current += 1;
    };
  }, [
    authIndex,
    connection,
    key,
    enabled,
    disabled,
    sessionActive,
    session,
    weeklyResetAtMs,
    requests,
  ]);

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const selected = pending?.grantId ?? (status ? selectResetGrant(status, now)?.id : undefined);
  const blocked = disabled || !sessionActive || !authIndex || busy || expired || !selected;
  const confirm = () => {
    if (blocked || lock.current || !selected || !authIndex) return;
    const version = generation.current;
    const current = () =>
      session === apiClient.getConnectionRevision() && version === generation.current;
    showConfirmation({
      title: t('claude_reset.title'),
      message: t(pending ? 'claude_reset.retry_confirm' : 'claude_reset.confirm_text', {
        name: plainIdentity(file.name, revealNames),
      }),
      confirmText: t(pending ? 'claude_reset.retry' : 'claude_reset.confirm'),
      variant: 'primary',
      onConfirm: async () => {
        if (!current() || lock.current || useAuthStore.getState().connectionStatus !== 'connected')
          return;
        lock.current = true;
        setBusy(true);
        try {
          const answer = await resetGrantOperations.run(key, authIndex, selected);
          if (!current()) return;
          showNotification(
            t(`claude_reset.${answer.unresolved ? 'unknown' : answer.code}`),
            !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used')
              ? 'success'
              : 'error'
          );
        } catch (error: unknown) {
          if (!current()) return;
          const unresolved = resetGrantOperations.inspect(key);
          showNotification(
            t(
              unresolved && !unresolved.code
                ? 'claude_reset.unknown'
                : resetGrantFailureMessageKey(error),
              {
                code: error instanceof ResetGrantPreflightError ? error.reason : '',
              }
            ),
            'error'
          );
        } finally {
          lock.current = false;
          // A concurrent page-wide refresh can invalidate this read generation.
          // Release the local lock regardless, but never refresh a replacement account.
          setBusy(false);
          // Spending changes the grants: the next read goes upstream.
          resetGrantCache.request(connection, [authIndex]);
          if (current()) onRefresh();
        }
      },
    });
  };
  return {
    count: status?.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0) ?? null,
    grants: status?.grants ?? [],
    busy,
    blocked,
    confirm,
    message: pending ? (expired ? 'expired' : 'unknown') : message,
    buttonLabel: pending ? 'retry' : 'use',
  };
}
