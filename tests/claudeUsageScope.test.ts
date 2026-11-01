/**
 * Claude setup tokens lack the `user:profile` scope, so their usage, profile
 * and reset-grant reads can never succeed. The panel stops sending them.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import i18n from '@/i18n';
import { apiCallApi, type ApiCallRequest, type ApiCallResult } from '@/services/api/apiCall';
import { apiClient } from '@/services/api/client';
import { isClaudeOAuthScopeError } from '@/services/api/claudeUsage';
import { readClaudeResetGrants } from '@/services/api/claudeResetGrants';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import {
  claudeUsageScope,
  claudeUsageUnavailable,
  createClaudeUsageScope,
  forgetClaudeUsageScopeRefusal,
  isClaudeSetupToken,
} from '@/features/quota/providers/claude/usageScope';
import { quotaReadBlocked } from '@/features/quota/rateLimit';
import { CLAUDE_USAGE_URL } from '@/utils/quota';
import fixture from './fixtures/claude-oauth-usage.json';

const t = i18n.cloneInstance({ lng: 'en' }).t;
const unavailableMessage = t('claude_quota.usage_scope_missing');
// The live 403 for a setup token, as Anthropic sends it.
const scopeRefusal = {
  type: 'error',
  error: {
    type: 'permission_error',
    message: 'OAuth token does not meet scope requirement user:profile',
    details: {
      required_scopes: ['user:profile'],
      match: 'any',
      error_visibility: 'user_facing',
      error_code: 'oauth_scope_insufficient',
    },
  },
};
const file = { name: 'setup.json', type: 'claude', auth_index: 'setup-index', modified: 1000 };
const result = (statusCode: number, body: unknown): ApiCallResult => ({
  statusCode,
  header: {},
  body,
  bodyText: JSON.stringify(body),
});
const originalRequest = apiCallApi.request;
afterEach(() => {
  apiCallApi.request = originalRequest;
  claudeUsageScope.clear();
});

const recordCalls = (respond: (request: ApiCallRequest) => ApiCallResult) => {
  const calls: ApiCallRequest[] = [];
  apiCallApi.request = async (request) => {
    calls.push(request);
    return respond(request);
  };
  return calls;
};

describe('scope refusal detection', () => {
  test('recognizes the setup-token 403 from the api-call response', async () => {
    const post = spyOn(apiClient, 'post').mockResolvedValue({
      status_code: 403,
      header: {},
      body: JSON.stringify(scopeRefusal),
    });
    try {
      const response = await apiCallApi.request({
        authIndex: 'a',
        method: 'GET',
        url: CLAUDE_USAGE_URL,
      });
      expect(isClaudeOAuthScopeError(response)).toBe(true);
    } finally {
      post.mockRestore();
    }
  });

  test('accepts the message alone, and nothing that is not a 403 scope refusal', () => {
    const message = { error: { message: 'OAuth token does not meet scope requirement x' } };
    expect(isClaudeOAuthScopeError(result(403, message))).toBe(true);
    expect(isClaudeOAuthScopeError(result(403, { error: { type: 'permission_error' } }))).toBe(
      false
    );
    expect(isClaudeOAuthScopeError(result(403, {}))).toBe(false);
    expect(isClaudeOAuthScopeError(result(429, scopeRefusal))).toBe(false);
    expect(isClaudeOAuthScopeError(result(401, scopeRefusal))).toBe(false);
  });
});

describe('after a scope refusal', () => {
  test('usage, profile and reset-grant reads stop, with a message instead of an error', async () => {
    const calls = recordCalls(() => result(403, scopeRefusal));
    await expect(CLAUDE_CONFIG.fetchQuota(file, t)).rejects.toThrow(unavailableMessage);
    expect(calls).toHaveLength(2); // usage and profile, sent together once
    expect(claudeUsageUnavailable(file)).toBe(true);
    // Refresh-all, the stale-on-visit refresh, and the reset-grant card read skip it.
    expect(quotaReadBlocked('claude', file)).toBe(true);

    calls.length = 0;
    await expect(CLAUDE_CONFIG.fetchQuota(file, t)).rejects.toThrow(unavailableMessage);
    expect(calls).toHaveLength(0);
  });

  test('a reset-grant read reports the refusal as its own code', async () => {
    recordCalls(() => result(403, scopeRefusal));
    await expect(readClaudeResetGrants('setup-index')).rejects.toMatchObject({ code: 'scope' });
    recordCalls(() => result(403, {}));
    await expect(readClaudeResetGrants('setup-index')).rejects.toMatchObject({ code: 'auth' });
  });

  test('the refusal persists across reloads and tabs', () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
    const deps = { connection: () => 'http://panel.test', storage: () => storage };
    createClaudeUsageScope(deps).record('a', 1000);
    const reloaded = createClaudeUsageScope(deps);
    expect(reloaded.refused('a', 1000)).toBe(true);
    expect(reloaded.refused('b', 1000)).toBe(false);
    expect(
      createClaudeUsageScope({ ...deps, connection: () => 'http://other.test' }).refused('a', 1000)
    ).toBe(false);
  });

  test('stops applying when the auth file changes', () => {
    claudeUsageScope.record('setup-index', 1000);
    expect(claudeUsageUnavailable(file)).toBe(true);
    expect(claudeUsageUnavailable({ ...file, modified: 2000 })).toBe(false);
    // A listing without modified times cannot tell; the refusal holds.
    expect(claudeUsageUnavailable({ ...file, modified: undefined })).toBe(true);
  });

  test('an explicit card refresh and a successful read both clear it', async () => {
    claudeUsageScope.record('setup-index', 1000);
    forgetClaudeUsageScopeRefusal(file);
    expect(claudeUsageUnavailable(file)).toBe(false);

    claudeUsageScope.record('setup-index', undefined);
    expect(claudeUsageUnavailable(file)).toBe(true);
    claudeUsageScope.forget('setup-index');
    recordCalls((request) =>
      request.url === CLAUDE_USAGE_URL ? result(200, fixture) : result(200, {})
    );
    await CLAUDE_CONFIG.fetchQuota(file, t);
    expect(claudeUsageUnavailable(file)).toBe(false);
  });
});

describe('setup tokens declared by the credential listing', () => {
  test('are skipped up front, before any request', async () => {
    const calls = recordCalls(() => result(200, fixture));
    for (const declared of [
      { ...file, is_setup_token: true },
      { ...file, metadata: { is_setup_token: true } },
      { ...file, attributes: { is_setup_token: 'true' } },
    ]) {
      expect(isClaudeSetupToken(declared)).toBe(true);
      expect(quotaReadBlocked('claude', declared)).toBe(true);
      await expect(CLAUDE_CONFIG.fetchQuota(declared, t)).rejects.toThrow(unavailableMessage);
    }
    expect(calls).toHaveLength(0);
    expect(isClaudeSetupToken({ ...file, is_setup_token: false })).toBe(false);
    expect(isClaudeSetupToken(file)).toBe(false);
  });
});

test('the setup-token message is translated in all six locales', async () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
    const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
    expect(messages.claude_quota.usage_scope_missing).toContain('Setup');
  }
});
