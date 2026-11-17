import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { useAuthStore } from '@/stores/useAuthStore';
import { useConfigStore } from '@/stores/useConfigStore';
import type { Config } from '@/types';
import { STORAGE_KEY_AUTH } from '@/utils/constants';
import { isCurrentObfuscated } from '@/utils/encryption';

// Each query string loads a separate module instance, standing in for an earlier page load.
const loadEncryption = (load: string) =>
  import(`../src/utils/encryption.ts?load=${load}`) as Promise<typeof import('@/utils/encryption')>;

// A separate store instance shares localStorage with this one, standing in for another tab or
// the next page load. It hydrates from localStorage as it loads, like a page does.
let storeLoads = 0;
const loadStore = async () => {
  storeLoads += 1;
  const module = (await import(
    `../src/stores/useAuthStore.ts?load=${storeLoads}`
  )) as typeof import('@/stores/useAuthStore');
  return module.useAuthStore;
};

// Written literally: renaming the entry would lose every saved key.
const SAVED_KEY_ENTRY = 'cli-proxy-management-key';
const API_BASE = 'https://proxy.invalid';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalFetchConfig = useConfigStore.getState().fetchConfig;
const spies: Array<{ mockRestore(): void }> = [];
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
    connectionStatus: 'disconnected',
  });
});

afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  // Zustand replaces its state object; mockRestore alone can leave the mocked action in new states.
  useConfigStore.setState({ fetchConfig: originalFetchConfig });
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  for (const [key, descriptor] of [
    ['localStorage', originalStorage],
    ['window', originalWindow],
    ['navigator', originalNavigator],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** The config request login() and checkAuth() make; resolves when the test says so. */
const mockConfigRequest = () => {
  let respond: () => void = () => {};
  const response = new Promise<Config>((resolve) => {
    respond = () => resolve({} as Config);
  });
  spies.push(spyOn(useConfigStore.getState(), 'fetchConfig').mockReturnValue(response));
  return respond;
};

const mockConnectedBackend = () => mockConfigRequest()();

const logIn = (managementKey: string, rememberPassword: boolean) =>
  useAuthStore.getState().login({ apiBase: API_BASE, managementKey, rememberPassword });

// The v1 format the previous build wrote: XOR keyed by salt, host and User-Agent.
const encodeV1 = (value: string, host: string, userAgent: string) => {
  const key = new TextEncoder().encode(`cli-proxy-api-webui::secure-storage|${host}|${userAgent}`);
  const bytes = new TextEncoder().encode(value).map((byte, i) => byte ^ key[i % key.length]);
  return `enc::v1::${btoa(String.fromCharCode(...bytes))}`;
};

const savedRecord = () =>
  obfuscatedStorage.getItem<{ state: { managementKey?: string } }>(STORAGE_KEY_AUTH);

const savedKey = () => obfuscatedStorage.getItem<string>(SAVED_KEY_ENTRY);

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
    expect(savedKey()).toBe('test-key');
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

  test('a remembered login is saved and restored on the next load', async () => {
    mockConnectedBackend();
    await logIn('test-key', true);
    expect(isCurrentObfuscated(values.get(SAVED_KEY_ENTRY) ?? '')).toBe(true);
    const nextLoad = await loadStore();
    expect(nextLoad.getState().managementKey).toBe('test-key');
    expect(nextLoad.getState().rememberPassword).toBe(true);
  });

  test('the persist record never holds the key', () => {
    useAuthStore.setState({ managementKey: 'test-key', rememberPassword: true });
    expect(savedRecord()?.state.managementKey).toBeUndefined();
  });
});

describe('only clearing login data deletes the saved key', () => {
  test('another tab saving its state without the key leaves the saved key', async () => {
    // Loaded before the login, so its state has no key and rememberPassword is false.
    const otherTab = await loadStore();
    mockConnectedBackend();
    await logIn('saved-key', true);
    // Any set() saves the whole state, for example a version header on an ordinary response.
    otherTab.getState().updateServerVersion('8.0.45', null);
    expect((await loadStore()).getState().managementKey).toBe('saved-key');
  });

  test('logging in without Remember neither saves the new key nor removes the saved one', async () => {
    mockConnectedBackend();
    await logIn('saved-key', true);
    await logIn('other-key', false);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect((await loadStore()).getState().managementKey).toBe('saved-key');
  });

  test('signing out keeps the saved key and stops automatic login', async () => {
    mockConnectedBackend();
    await logIn('saved-key', true);
    expect(useAuthStore.getState().hasRestorableSession()).toBe(true);
    useAuthStore.getState().signOut();
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.managementKey).toBe('saved-key');
    expect(state.rememberPassword).toBe(true);
    expect(values.has('isLoggedIn')).toBe(false);
    expect(state.hasRestorableSession()).toBe(false);
    expect(savedKey()).toBe('saved-key');
    expect((await loadStore()).getState().managementKey).toBe('saved-key');
  });

  test('clearing login data deletes the saved key', async () => {
    mockConnectedBackend();
    await logIn('saved-key', true);
    expect(savedKey()).toBe('saved-key');
    useAuthStore.getState().clearSavedLogin();
    expect(useAuthStore.getState().managementKey).toBe('');
    expect(useAuthStore.getState().rememberPassword).toBe(false);
    expect(values.has(SAVED_KEY_ENTRY)).toBe(false);
    expect(values.has('isLoggedIn')).toBe(false);
    expect((await loadStore()).getState().managementKey).toBe('');
  });

  test('another tab that still holds the key does not save it again after clearing', async () => {
    mockConnectedBackend();
    await logIn('saved-key', true);
    const otherTab = await loadStore();
    expect(otherTab.getState().managementKey).toBe('saved-key');
    useAuthStore.getState().clearSavedLogin();
    otherTab.getState().updateServerVersion('8.0.45', null);
    expect((await loadStore()).getState().managementKey).toBe('');
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

describe('a key saved by an earlier build', () => {
  const saveRecordWithKey = (managementKey: string) =>
    obfuscatedStorage.setItem(STORAGE_KEY_AUTH, {
      state: { apiBase: API_BASE, managementKey, rememberPassword: true },
      version: 0,
    });

  test('moves from the persist record into its own entry', async () => {
    saveRecordWithKey('saved-key');
    values.set('isLoggedIn', 'true');
    const nextLoad = await loadStore();
    expect(nextLoad.getState().managementKey).toBe('saved-key');
    expect(savedKey()).toBe('saved-key');
    expect(savedRecord()?.state.managementKey).toBeUndefined();
    expect(values.get('isLoggedIn')).toBe('true');
    // Once moved, a state write without the key no longer removes it.
    useAuthStore.getState().updateServerVersion('8.0.45', null);
    expect((await loadStore()).getState().managementKey).toBe('saved-key');
  });

  test('does not replace a key already in its own entry', async () => {
    obfuscatedStorage.setItem(SAVED_KEY_ENTRY, 'entry-key');
    saveRecordWithKey('record-key');
    expect((await loadStore()).getState().managementKey).toBe('entry-key');
    expect(savedKey()).toBe('entry-key');
  });
});

describe('a sign-out while a login request is outstanding', () => {
  test('is not undone when checkAuth resolves', async () => {
    const respond = mockConfigRequest();
    useAuthStore.setState({ apiBase: API_BASE, managementKey: 'saved-key' });
    values.set('isLoggedIn', 'true');
    const check = useAuthStore.getState().checkAuth();
    useAuthStore.getState().signOut();
    respond();
    expect(await check).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().connectionStatus).toBe('disconnected');
  });

  test('is not undone when login resolves', async () => {
    const respond = mockConfigRequest();
    const login = logIn('saved-key', true);
    useAuthStore.getState().signOut();
    respond();
    await login;
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().connectionStatus).toBe('disconnected');
    expect(values.has('isLoggedIn')).toBe(false);
    expect(values.has(SAVED_KEY_ENTRY)).toBe(false);
  });
});
