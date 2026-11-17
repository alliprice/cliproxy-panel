/**
 * 认证状态管理
 * 从原项目 src/modules/login.js 和 src/core/connection.js 迁移
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuthState, LoginCredentials, ConnectionStatus } from '@/types';
import { STORAGE_KEY_AUTH, STORAGE_KEY_MANAGEMENT_KEY } from '@/utils/constants';
import { isCurrentObfuscated } from '@/utils/encryption';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { apiClient } from '@/services/api/client';
import { LegacyBackendError, probeLegacyBackend } from '@/services/api/legacyBackendProbe';
import { useConfigStore } from './useConfigStore';
import { useModelsStore } from './useModelsStore';
import { useQuotaStore } from './useQuotaStore';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';

interface AuthStoreState extends AuthState {
  connectionStatus: ConnectionStatus;

  // 操作
  login: (credentials: LoginCredentials) => Promise<void>;
  /** Ends the session and keeps the saved key, so the login form shows it again. */
  signOut: () => void;
  /** The only action that deletes the saved key. */
  clearSavedLogin: () => void;
  hasRestorableSession: () => boolean;
  checkAuth: () => Promise<boolean>;
  restoreSession: () => Promise<boolean>;
  updateServerVersion: (version: string | null, buildDate?: string | null) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
}

let restoreSessionPromise: Promise<boolean> | null = null;

/*
 * The saved key has its own entry. zustand persist rewrites the whole STORAGE_KEY_AUTH record on
 * every set(), so a key kept there is lost whenever any state without it is saved, for example
 * by another tab. Only login() with Remember ticked writes the entry; only clearSavedLogin()
 * removes it.
 */
const readSavedManagementKey = (): string => {
  const key = obfuscatedStorage.getItem<unknown>(STORAGE_KEY_MANAGEMENT_KEY);
  return typeof key === 'string' ? key : '';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Moves a key that an earlier build saved inside the persist record into its own entry. */
const moveRecordKeyToEntry = (data: Record<string, unknown>): Record<string, unknown> => {
  if (!isRecord(data.state) || !('managementKey' in data.state)) return data;
  const { managementKey, ...state } = data.state;
  if (
    typeof managementKey === 'string' &&
    managementKey &&
    localStorage.getItem(STORAGE_KEY_MANAGEMENT_KEY) === null
  ) {
    obfuscatedStorage.setItem(STORAGE_KEY_MANAGEMENT_KEY, managementKey);
  }
  return { ...data, state };
};

export const useAuthStore = create<AuthStoreState>()(
  persist(
    (set, get) => ({
      // 初始状态
      isAuthenticated: false,
      apiBase: '',
      managementKey: '',
      rememberPassword: false,
      serverVersion: null,
      serverBuildDate: null,
      supportsPlugin: false,
      connectionStatus: 'disconnected',

      // 恢复会话并自动登录
      restoreSession: () => {
        if (restoreSessionPromise) return restoreSessionPromise;

        restoreSessionPromise = (async () => {
          const wasLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
          const legacyBase =
            obfuscatedStorage.getItem<string>('apiBase') ||
            obfuscatedStorage.getItem<string>('apiUrl', { encrypt: true });
          const { apiBase, managementKey, rememberPassword } = get();
          const resolvedBase = normalizeApiBase(
            apiBase || legacyBase || detectApiBaseFromLocation()
          );
          const resolvedKey = managementKey || '';
          const resolvedRememberPassword = rememberPassword;

          set({
            apiBase: resolvedBase,
            managementKey: resolvedKey,
            rememberPassword: resolvedRememberPassword,
          });
          apiClient.setConfig({ apiBase: resolvedBase, managementKey: resolvedKey });

          if (wasLoggedIn && resolvedBase && resolvedKey) {
            try {
              await get().login({
                apiBase: resolvedBase,
                managementKey: resolvedKey,
                rememberPassword: resolvedRememberPassword,
              });
              // False when a sign-out during the request discarded its result.
              return get().isAuthenticated;
            } catch (error) {
              console.warn('Auto login failed:', error);
              return false;
            }
          }

          return false;
        })();

        return restoreSessionPromise;
      },

      // 登录
      login: async (credentials) => {
        const apiBase = normalizeApiBase(credentials.apiBase);
        const managementKey = credentials.managementKey.trim();
        const rememberPassword = credentials.rememberPassword ?? get().rememberPassword ?? false;

        try {
          set({
            connectionStatus: 'connecting',
            serverVersion: null,
            serverBuildDate: null,
            supportsPlugin: false,
          });
          useConfigStore.getState().clearCache();
          useModelsStore.getState().clearCache();
          useQuotaStore.getState().clearQuotaCache();

          // 配置 API 客户端
          apiClient.setConfig({
            apiBase,
            managementKey,
          });

          // 测试连接 - 获取配置。只在 v8 路由不存在时诊断旧版后端。
          const revision = apiClient.getConnectionRevision();
          try {
            await useConfigStore.getState().fetchConfig(true);
          } catch (error) {
            if (
              (error as { status?: number })?.status === 404 &&
              revision === apiClient.getConnectionRevision() &&
              (await probeLegacyBackend(apiBase, managementKey)) &&
              revision === apiClient.getConnectionRevision()
            ) {
              throw new LegacyBackendError();
            }
            throw error;
          }

          // A sign-out or another login changed the connection while the request was outstanding.
          if (revision !== apiClient.getConnectionRevision()) return;

          // 登录成功
          set({
            isAuthenticated: true,
            apiBase,
            managementKey,
            rememberPassword,
            connectionStatus: 'connected',
          });
          if (rememberPassword) {
            obfuscatedStorage.setItem(STORAGE_KEY_MANAGEMENT_KEY, managementKey);
            localStorage.setItem('isLoggedIn', 'true');
          } else {
            // Without Remember the new key is not saved, and a key saved earlier stays saved.
            localStorage.removeItem('isLoggedIn');
          }
        } catch (error: unknown) {
          set({ connectionStatus: 'error' });
          throw error;
        }
      },

      signOut: () => {
        restoreSessionPromise = null;
        apiClient.setConfig({ apiBase: '', managementKey: '' });
        useConfigStore.getState().clearCache();
        useModelsStore.getState().clearCache();
        useQuotaStore.getState().clearQuotaCache();
        set({
          isAuthenticated: false,
          serverVersion: null,
          serverBuildDate: null,
          supportsPlugin: false,
          connectionStatus: 'disconnected',
        });
        // No automatic login on the next load; the login form offers the saved key instead.
        localStorage.removeItem('isLoggedIn');
      },

      clearSavedLogin: () => {
        get().signOut();
        obfuscatedStorage.removeItem(STORAGE_KEY_MANAGEMENT_KEY);
        set({ apiBase: '', managementKey: '', rememberPassword: false });
      },

      hasRestorableSession: () => {
        const { apiBase, managementKey } = get();
        return (
          localStorage.getItem('isLoggedIn') === 'true' &&
          Boolean(apiBase) &&
          Boolean(managementKey)
        );
      },

      // 检查认证状态
      checkAuth: async () => {
        const { managementKey, apiBase } = get();

        if (!managementKey || !apiBase) {
          return false;
        }

        try {
          // 重新配置客户端
          apiClient.setConfig({ apiBase, managementKey });
          set({ supportsPlugin: false });
          const revision = apiClient.getConnectionRevision();

          // 验证连接
          await useConfigStore.getState().fetchConfig();

          // A sign-out while the request was outstanding must not be undone by its response.
          if (revision !== apiClient.getConnectionRevision()) return false;

          set({
            isAuthenticated: true,
            connectionStatus: 'connected',
          });

          return true;
        } catch {
          set({
            isAuthenticated: false,
            connectionStatus: 'error',
            supportsPlugin: false,
          });
          return false;
        }
      },

      // 更新服务器版本
      updateServerVersion: (version, buildDate) => {
        set({
          serverVersion: version || null,
          serverBuildDate: buildDate || null,
        });
      },

      updateServerPluginSupport: (supportsPlugin) => {
        set({ supportsPlugin });
      },
    }),
    {
      name: STORAGE_KEY_AUTH,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          const raw = localStorage.getItem(name);
          if (!raw) return null;
          const data = obfuscatedStorage.getItem<unknown>(name);
          if (!isRecord(data)) return null;
          const record = moveRecordKeyToEntry(data);
          // Re-save a record in an older format or one that held the key. Loading never deletes
          // a saved login.
          if (record !== data || !isCurrentObfuscated(raw)) obfuscatedStorage.setItem(name, record);
          return JSON.stringify(record);
        },
        setItem: (name, value) => {
          obfuscatedStorage.setItem(name, JSON.parse(value));
        },
        removeItem: (name) => {
          obfuscatedStorage.removeItem(name);
        },
      })),
      // The key is never part of this record; it comes from its own entry on every load.
      merge: (persisted, current) => ({
        ...current,
        ...(isRecord(persisted) ? (persisted as Partial<AuthStoreState>) : {}),
        managementKey: readSavedManagementKey(),
      }),
      partialize: (state) => ({
        apiBase: state.apiBase,
        rememberPassword: state.rememberPassword,
        serverVersion: state.serverVersion,
        serverBuildDate: state.serverBuildDate,
      }),
    }
  )
);

// 监听全局未授权事件
if (typeof window !== 'undefined') {
  window.addEventListener('unauthorized', () => {
    useAuthStore.getState().signOut();
  });

  window.addEventListener('server-version-update', ((e: CustomEvent) => {
    const detail = e.detail || {};
    useAuthStore.getState().updateServerVersion(detail.version || null, detail.buildDate || null);
  }) as EventListener);

  window.addEventListener('server-plugin-support-update', ((e: CustomEvent) => {
    useAuthStore.getState().updateServerPluginSupport(e.detail?.supportsPlugin === true);
  }) as EventListener);
}
