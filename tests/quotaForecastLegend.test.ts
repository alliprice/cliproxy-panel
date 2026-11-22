/**
 * The forecast chart's legend: the All tab's split layout draws the
 * window-average comparison line, so it names both lines then, and only then.
 */

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { QuotaForecast } from '@/features/quota/components/QuotaForecast';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaSnapshot } from '@/features/quota/forecast/quotaHistory';
import type { AuthFileItem } from '@/types';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const NOW = Date.parse('2026-11-01T00:00:00Z');

const entries: QuotaFileEntry[] = ['a.json', 'b.json'].map((name) => ({
  file: { name, provider: 'claude', type: 'claude' } as AuthFileItem,
  type: 'claude',
}));

// Each account has used 70% over the 2 days of its 7-day window: 1.46 per hour
// each, 2.9 in all.
const quota = {
  status: 'success',
  windows: [
    {
      id: 'seven-day',
      label: 'Weekly',
      usedPercent: 70,
      resetAtMs: NOW + 5 * DAY_MS,
      periodHours: 168,
    },
  ],
};

// The last 3 hours: 0.1 per hour each, far under the window average.
const history: QuotaSnapshot[] = entries.flatMap(({ file }) =>
  [3, 2, 1, 0].map((hoursAgo, index) => ({
    connection: 'test',
    ts: NOW - hoursAgo * HOUR_MS,
    credentialId: file.name,
    provider: 'claude',
    window: 'seven-day',
    remaining: 30.3 - 0.1 * index,
    resetAtMs: NOW + 5 * DAY_MS,
    primary: true,
  }))
);

// English through a cloned instance: changing the shared one would leak into other test files.
const english = i18n.cloneInstance({ lng: 'en' });

const render = (recorded: QuotaSnapshot[], layout: 'split' | 'stacked') =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: english },
      createElement(QuotaForecast, {
        provider: 'claude',
        entries,
        quotaFor: () => quota as never,
        history: recorded,
        snapshotsFor: (credentialId: string, windowId: string) =>
          recorded.filter(
            (snapshot) => snapshot.credentialId === credentialId && snapshot.window === windowId
          ),
        nowMs: NOW,
        resolvedTheme: 'light',
        layout,
        chartHeight: 120,
        lookbackHours: 6,
        collapsed: false,
        onLookbackHoursChange: () => {},
        onCollapsedChange: () => {},
      })
    )
  );

describe('the legend of the forecast chart', () => {
  test('the split layout names both lines when the comparison is drawn', () => {
    const markup = render(history, 'split');
    expect(markup).toContain('Recent pace');
    expect(markup).toContain('Window average');
    expect(markup).not.toContain('Projected');
  });

  test('the split layout has no legend without the comparison', () => {
    const markup = render([], 'split');
    expect(markup).not.toContain('Recent pace');
    expect(markup).not.toContain('Window average');
    expect(markup).not.toContain('Projected');
  });

  test('the stacked layout is unchanged: legend with the comparison, projected without', () => {
    const compared = render(history, 'stacked');
    expect(compared).toContain('Recent pace');
    expect(compared).toContain('Window average');
    expect(render([], 'stacked')).toContain('Projected');
  });
});
