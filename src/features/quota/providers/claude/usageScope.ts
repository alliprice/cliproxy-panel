/**
 * Claude credentials whose OAuth token cannot read usage.
 *
 * A setup token (`claude setup-token`) has no `user:profile` scope, so
 * Anthropic answers its usage and profile reads with 403
 * `oauth_scope_insufficient` (or 429 while the token is rate limited), and
 * asking again never succeeds. Such a credential sends no Claude usage,
 * profile or reset-grant reads:
 * - up front, when the credential listing marks it `is_setup_token`;
 * - after the first such 403, recorded per connection and auth_index in
 *   localStorage without expiry. The record stops applying when the auth file
 *   changes (another modified time), and is dropped when a usage read succeeds
 *   or the user refreshes the card.
 * The card keeps the passive readings CLIProxyAPI takes from proxy traffic.
 */

import { useAuthStore } from '@/stores/useAuthStore';
import { browserLocalStorage, createSharedRecord } from '@/services/storage/sharedRecord';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';

export const CLAUDE_USAGE_SCOPE_STORAGE_KEY = 'quota.claudeUsageScopeMissing';

interface ScopeRefusal {
  /** The auth file's modified time when the refusal was seen, if the listing gave one. */
  modified: number | null;
}

const refusals = (value: unknown): Record<string, ScopeRefusal> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, ScopeRefusal] =>
            isRecord(entry[1]) &&
            (entry[1].modified === null ||
              (typeof entry[1].modified === 'number' && Number.isFinite(entry[1].modified)))
        )
      )
    : {};

interface ScopeDependencies {
  connection: () => string;
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

const defaultDependencies: ScopeDependencies = {
  connection: () => useAuthStore.getState().apiBase,
  storage: browserLocalStorage,
};

export function createClaudeUsageScope(deps: ScopeDependencies = defaultDependencies) {
  const record = createSharedRecord<ScopeRefusal>({
    key: CLAUDE_USAGE_SCOPE_STORAGE_KEY,
    sanitize: refusals,
    storage: deps.storage,
    crossTab: deps === defaultDependencies,
  });
  const keyOf = (authIndex: string) => `${deps.connection()}|${authIndex}`;

  return {
    /** Whether a recorded refusal applies to this version of the credential's file. */
    refused(authIndex: string, modified: number | undefined): boolean {
      const refusal = record.read()[keyOf(authIndex)];
      if (!refusal) return false;
      return refusal.modified === null || modified === undefined || refusal.modified === modified;
    },
    record(authIndex: string, modified: number | undefined) {
      const key = keyOf(authIndex);
      const value = modified ?? null;
      if (record.read()[key]?.modified === value) return;
      record.write({ ...record.read(), [key]: { modified: value } });
    },
    forget(authIndex: string) {
      const key = keyOf(authIndex);
      if (!(key in record.read())) return;
      const next = { ...record.read() };
      delete next[key];
      record.write(next);
    },
    subscribe: record.subscribe,
    clear: record.clear,
  };
}

export const claudeUsageScope = createClaudeUsageScope();

const isTrue = (value: unknown) => value === true || value === 'true';

/** Whether the credential listing says the credential is a setup token. */
export function isClaudeSetupToken(file: AuthFileItem): boolean {
  const metadata = isRecord(file.metadata) ? file.metadata : null;
  const attributes = isRecord(file.attributes) ? file.attributes : null;
  return [
    file['is_setup_token'],
    file.isSetupToken,
    metadata?.is_setup_token,
    attributes?.is_setup_token,
  ].some(isTrue);
}

const authIndexOf = (file: AuthFileItem) =>
  normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
const modifiedOf = (file: AuthFileItem) =>
  typeof file.modified === 'number' && Number.isFinite(file.modified) ? file.modified : undefined;

/** Whether the credential's token cannot read Claude usage, so nothing should be sent. */
export function claudeUsageUnavailable(file: AuthFileItem): boolean {
  if (isClaudeSetupToken(file)) return true;
  const authIndex = authIndexOf(file);
  return authIndex !== null && claudeUsageScope.refused(authIndex, modifiedOf(file));
}

/** Records Anthropic's scope refusal for the credential. */
export function recordClaudeUsageScopeRefusal(file: AuthFileItem) {
  const authIndex = authIndexOf(file);
  if (authIndex) claudeUsageScope.record(authIndex, modifiedOf(file));
}

/** Drops a recorded refusal: a usage read succeeded, or the user asked to try again. */
export function forgetClaudeUsageScopeRefusal(file: AuthFileItem) {
  const authIndex = authIndexOf(file);
  if (authIndex) claudeUsageScope.forget(authIndex);
}
