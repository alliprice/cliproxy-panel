import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { useAuthStore } from '@/stores/useAuthStore';
import { STORAGE_KEY_AUTH } from '@/utils/constants';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let values: Map<string, string>;

const setUserAgent = (userAgent: string) =>
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent } });

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  useAuthStore.setState({ isAuthenticated: false, apiBase: '', managementKey: '' });
});

afterEach(() => {
  for (const [key, descriptor] of [
    ['localStorage', originalStorage],
    ['window', originalWindow],
    ['navigator', originalNavigator],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('v2 login persistence', () => {
  test.each(['enc::v1::obsolete', '{"state":{"managementKey":"old-key"}}'])(
    'discards old auth storage without migrating it: %s',
    async (raw) => {
      values.set(STORAGE_KEY_AUTH, raw);
      values.set('managementKey', 'legacy-key');
      values.set('isLoggedIn', 'true');
      values.set('theme', 'dark');
      values.set('language', 'zh-CN');
      await useAuthStore.persist.rehydrate();
      expect(useAuthStore.getState().managementKey).toBe('');
      expect(values.has(STORAGE_KEY_AUTH)).toBe(false);
      expect(values.has('managementKey')).toBe(false);
      expect(values.has('isLoggedIn')).toBe(false);
      expect(values.get('theme')).toBe('dark');
      expect(values.get('language')).toBe('zh-CN');
    }
  );

  test('does not restore standalone legacy credentials without an auth record', async () => {
    values.delete(STORAGE_KEY_AUTH);
    values.set('managementKey', 'legacy-key');
    values.set('isLoggedIn', 'true');
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().managementKey).toBe('');
    expect(values.has('managementKey')).toBe(false);
    expect(values.has('isLoggedIn')).toBe(false);
  });

  test('restores a new remembered login', async () => {
    obfuscatedStorage.setItem(STORAGE_KEY_AUTH, {
      state: {
        apiBase: 'http://proxy.example.com',
        managementKey: 'test-key',
        rememberPassword: true,
      },
      version: 0,
    });
    values.set('isLoggedIn', 'true');
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().managementKey).toBe('test-key');
    expect(useAuthStore.getState().rememberPassword).toBe(true);
    expect(values.get('isLoggedIn')).toBe('true');
  });

  test('a long remembered key survives a browser version update', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { host: '127.0.0.1:8317' } },
    });
    const chrome = (major: number) =>
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    // Long enough to reach the User-Agent part of a UA-keyed XOR key, which is what corrupted it.
    const managementKey = 'test-only-key-'.repeat(8);
    setUserAgent(chrome(141));
    obfuscatedStorage.setItem(STORAGE_KEY_AUTH, {
      state: {
        apiBase: 'http://127.0.0.1:8317',
        managementKey,
        rememberPassword: true,
        serverVersion: '8.0.45',
        serverBuildDate: '2026-10-27T15:23:26Z',
      },
      version: 0,
    });
    setUserAgent(chrome(142));
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().managementKey).toBe(managementKey);
  });

  test('does not persist a key when remember password is disabled', () => {
    useAuthStore.setState({ managementKey: 'not-persisted', rememberPassword: false });
    const saved = obfuscatedStorage.getItem<{ state: { managementKey?: string } }>(
      STORAGE_KEY_AUTH
    );
    expect(saved?.state.managementKey).toBeUndefined();
  });
});
