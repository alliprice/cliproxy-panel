import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { useAuthStore } from '@/stores/useAuthStore';
import { STORAGE_KEY_AUTH } from '@/utils/constants';
import { isCurrentObfuscated } from '@/utils/encryption';

// Each query string loads a separate module instance, standing in for an earlier page load.
const loadEncryption = (load: string) =>
  import(`../src/utils/encryption.ts?load=${load}`) as Promise<
    typeof import('@/utils/encryption')
  >;

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
  useAuthStore.setState({
    isAuthenticated: false,
    apiBase: '',
    managementKey: '',
    rememberPassword: false,
  });
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

// The v1 format the previous build wrote: XOR keyed by salt, host and User-Agent.
const encodeV1 = (value: string, host: string, userAgent: string) => {
  const key = new TextEncoder().encode(`cli-proxy-api-webui::secure-storage|${host}|${userAgent}`);
  const bytes = new TextEncoder().encode(value).map((byte, i) => byte ^ key[i % key.length]);
  return `enc::v1::${btoa(String.fromCharCode(...bytes))}`;
};

const savedRecord = () =>
  obfuscatedStorage.getItem<{ state: { managementKey?: string } }>(STORAGE_KEY_AUTH);

describe('v2 login persistence', () => {
  test('converts a login saved by the previous build instead of deleting it', async () => {
    const host = '127.0.0.1:8317';
    const userAgent = 'Mozilla/5.0 (Macintosh; rv:160.0) Gecko/20100101 Firefox/160.0';
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { host } },
    });
    setUserAgent(userAgent);
    const state = { apiBase: `http://${host}`, managementKey: 'test-key', rememberPassword: true };
    values.set(STORAGE_KEY_AUTH, encodeV1(JSON.stringify({ state, version: 0 }), host, userAgent));
    values.set('isLoggedIn', 'true');
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().managementKey).toBe('test-key');
    expect(isCurrentObfuscated(values.get(STORAGE_KEY_AUTH) ?? '')).toBe(true);
    expect(savedRecord()?.state.managementKey).toBe('test-key');
    expect(values.get('isLoggedIn')).toBe('true');
  });

  test('converts a plaintext saved login instead of deleting it', async () => {
    values.set(STORAGE_KEY_AUTH, '{"state":{"managementKey":"old-key"},"version":0}');
    values.set('isLoggedIn', 'true');
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().managementKey).toBe('old-key');
    expect(isCurrentObfuscated(values.get(STORAGE_KEY_AUTH) ?? '')).toBe(true);
    expect(values.get('isLoggedIn')).toBe('true');
  });

  test('loading an unreadable record restores nothing and deletes nothing', async () => {
    values.set(STORAGE_KEY_AUTH, 'enc::v1::obsolete');
    values.set('isLoggedIn', 'true');
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().managementKey).toBe('');
    expect(values.get('isLoggedIn')).toBe('true');
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
    const earlierPageLoad = await loadEncryption('chrome-141');
    values.set(
      STORAGE_KEY_AUTH,
      earlierPageLoad.obfuscateData(
        JSON.stringify({
          state: {
            apiBase: 'http://127.0.0.1:8317',
            managementKey,
            rememberPassword: true,
            serverVersion: '8.0.45',
            serverBuildDate: '2026-10-27T15:23:26Z',
          },
          version: 0,
        })
      )
    );
    setUserAgent(chrome(142));
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().managementKey).toBe(managementKey);
  });

  test('a remembered login is saved by the store and restored on the next load', async () => {
    useAuthStore.setState({
      apiBase: 'http://127.0.0.1:8317',
      managementKey: 'test-key',
      rememberPassword: true,
    });
    const saved = values.get(STORAGE_KEY_AUTH) ?? '';
    expect(isCurrentObfuscated(saved)).toBe(true);
    // Clear the in-memory key so only the saved record can bring it back.
    useAuthStore.setState({ managementKey: '' });
    values.set(STORAGE_KEY_AUTH, saved);
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().managementKey).toBe('test-key');
    expect(useAuthStore.getState().rememberPassword).toBe(true);
  });

  test('does not persist a key when remember password is disabled', () => {
    useAuthStore.setState({ managementKey: 'not-persisted', rememberPassword: false });
    const saved = obfuscatedStorage.getItem<{ state: { managementKey?: string } }>(
      STORAGE_KEY_AUTH
    );
    expect(saved?.state.managementKey).toBeUndefined();
  });
});

describe('only clearing login data deletes the saved key', () => {
  const rememberedLogin = () => {
    useAuthStore.setState({
      isAuthenticated: true,
      apiBase: 'http://127.0.0.1:8317',
      managementKey: 'test-key',
      rememberPassword: true,
    });
    values.set('isLoggedIn', 'true');
  };

  test('signing out keeps the saved key and stops automatic login', () => {
    rememberedLogin();
    expect(useAuthStore.getState().hasRestorableSession()).toBe(true);
    useAuthStore.getState().signOut();
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.managementKey).toBe('test-key');
    expect(state.rememberPassword).toBe(true);
    expect(savedRecord()?.state.managementKey).toBe('test-key');
    expect(values.has('isLoggedIn')).toBe(false);
    expect(state.hasRestorableSession()).toBe(false);
  });

  test('clearing login data deletes the saved key', () => {
    rememberedLogin();
    useAuthStore.getState().clearSavedLogin();
    expect(useAuthStore.getState().managementKey).toBe('');
    expect(useAuthStore.getState().rememberPassword).toBe(false);
    expect(savedRecord()?.state.managementKey).toBeFalsy();
    expect(values.has('isLoggedIn')).toBe(false);
  });

  test('a 401 and the Logout button sign out; the System page clears the key', async () => {
    const store = await Bun.file('src/stores/useAuthStore.ts').text();
    expect(store).toMatch(
      /addEventListener\('unauthorized', \(\) => \{\s*useAuthStore\.getState\(\)\.signOut\(\);/
    );
    const layout = await Bun.file('src/components/layout/MainLayout.tsx').text();
    expect(layout).toContain('onClick={signOut}');
    const system = await Bun.file('src/pages/SystemPage.tsx').text();
    expect(system).toContain('auth.clearSavedLogin();');
  });

  test('a protected page logs back in only from a restorable session', async () => {
    const source = await Bun.file('src/router/ProtectedRoute.tsx').text();
    expect(source).toContain('if (!isAuthenticated && hasRestorableSession())');
  });
});
