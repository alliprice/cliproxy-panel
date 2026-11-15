import { afterEach, describe, expect, test } from 'bun:test';
import { isCurrentObfuscated, obfuscateData } from '@/utils/encryption';

// Each query string loads a separate module instance, standing in for a fresh page load.
const loadEncryption = (load: string) =>
  import(`../src/utils/encryption.ts?load=${load}`) as Promise<
    typeof import('@/utils/encryption')
  >;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  for (const [key, descriptor] of [
    ['window', originalWindow],
    ['navigator', originalNavigator],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('v2 storage obfuscation', () => {
  test('a value saved before a browser update reads back after it', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { host: 'panel.example.com' } },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/158.0' },
    });
    const beforeUpdate = await loadEncryption('before-update');
    // Long enough to exercise the UA-dependent portion of the old XOR key.
    const value = JSON.stringify({ managementKey: 'test-only-'.repeat(100), label: '测试' });
    const encoded = beforeUpdate.obfuscateData(value);
    expect(encoded.startsWith('enc::v2::')).toBe(true);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/159.0' },
    });
    const afterUpdate = await loadEncryption('after-update');
    expect(afterUpdate.deobfuscateData(encoded)).toBe(value);
    expect(afterUpdate.obfuscateData(value)).toBe(encoded);
  });

  test('auth format detection rejects legacy and plaintext values', () => {
    expect(isCurrentObfuscated('enc::v1::old')).toBe(false);
    expect(isCurrentObfuscated('plaintext')).toBe(false);
    expect(isCurrentObfuscated(obfuscateData('test-key'))).toBe(true);
  });
});
