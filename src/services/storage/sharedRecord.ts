/**
 * A JSON record in localStorage that every tab of the panel shares, falling
 * back to memory when storage is unavailable (private mode, tests).
 */

type RecordStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const browserLocalStorage = (): RecordStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export interface SharedRecordOptions<T> {
  key: string;
  /** Keeps only well-formed entries of a stored value. */
  sanitize: (value: unknown) => Record<string, T>;
  storage?: () => RecordStorage | null;
  /** Re-read and notify when another tab writes the key (browser only). */
  crossTab?: boolean;
}

export function createSharedRecord<T>({
  key,
  sanitize,
  storage = browserLocalStorage,
  crossTab = false,
}: SharedRecordOptions<T>) {
  let memory: Record<string, T> = {};
  let cached: Record<string, T> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());

  if (crossTab && typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== null && event.key !== key) return;
      cached = null;
      emit();
    });
  }

  return {
    read(): Record<string, T> {
      if (cached) return cached;
      const store = storage();
      if (!store) return memory;
      try {
        cached = sanitize(JSON.parse(store.getItem(key) ?? '{}'));
      } catch {
        cached = { ...memory };
      }
      return cached;
    },
    write(next: Record<string, T>) {
      memory = next;
      cached = next;
      try {
        storage()?.setItem(key, JSON.stringify(next));
      } catch {
        // Quota or privacy errors: the value still holds for this tab.
      }
      emit();
    },
    clear() {
      memory = {};
      cached = null;
      try {
        storage()?.removeItem(key);
      } catch {
        // Nothing stored.
      }
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
