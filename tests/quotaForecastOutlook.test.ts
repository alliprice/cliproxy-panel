/**
 * The forecast outlook rows: the figures at the recent pace, with the
 * window-average ones next to them while that projection shows.
 */

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { Outlook } from '@/features/quota/components/QuotaForecast';
import { formatCompactDuration } from '@/features/quota/display';
import {
  buildQuotaForecast,
  type LiveReading,
  type QuotaForecast,
} from '@/features/quota/forecast/forecastModel';
import type { QuotaSnapshot } from '@/features/quota/forecast/quotaHistory';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const NOW = Date.parse('2026-11-01T00:00:00Z');

const reading = (credentialId: string, remaining: number): LiveReading => ({
  credentialId,
  remaining,
  resetAtMs: null,
  periodHours: 168,
  ratePerHour: 10,
  averagePerHour: 20,
});
const snapshot = (credentialId: string, hoursAgo: number, remaining: number): QuotaSnapshot => ({
  connection: 'test',
  ts: NOW - hoursAgo * HOUR_MS,
  credentialId,
  provider: 'claude',
  window: 'seven-day',
  remaining,
  resetAtMs: null,
  primary: true,
});

// a used 30% over the last 3 hours and b nothing: a recent pace of 10 per hour,
// against window averages adding up to 40 per hour.
const live = [reading('a', 30), reading('b', 100)];
const history = [
  ...[3, 2, 1, 0].map((hours, index) => snapshot('a', hours, 60 - 10 * index)),
  ...[3, 2, 1, 0].map((hours) => snapshot('b', hours, 100)),
];
const build = (recorded: QuotaSnapshot[]) =>
  buildQuotaForecast({
    live,
    history: recorded,
    nowMs: NOW,
    rangeMs: 7 * DAY_MS,
    lookbackMs: 6 * HOUR_MS,
    enoughMs: 2 * HOUR_MS,
  });
// English through a cloned instance: changing the shared one would leak into other test files.
const english = i18n.cloneInstance({ lng: 'en' });
const rows = (forecast: QuotaForecast) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: english },
      createElement(Outlook, { forecast, accounts: 2, nowMs: NOW })
    )
  );
const inDuration = (atMs: number) => formatCompactDuration(atMs - NOW);

describe('the outlook at the window-average pace', () => {
  const forecast = build(history);

  test('adds the window-average figures to the first-out and all-out rows', () => {
    expect(forecast.drain).toMatchObject({ ratePerHour: 10, source: 'history', windowAverage: 40 });
    // Recent pace: 5 per hour each, a out at 6h, then b alone at 10, out at 13h.
    // Window average: 20 each, a out at 1h30, then b alone at 40, out at 3h15.
    expect(forecast.firstRunsOutAtMs).toBeCloseTo(NOW + 6 * HOUR_MS, -3);
    expect(forecast.allOutAtMs).toBeCloseTo(NOW + 13 * HOUR_MS, -3);
    const average = forecast.atWindowAverage!;
    expect(average.firstRunsOutAtMs).toBeCloseTo(NOW + 90 * MINUTE_MS, -3);
    expect(average.allOutAtMs).toBeCloseTo(NOW + 195 * MINUTE_MS, -3);

    const markup = rows(forecast);
    expect(markup).toContain(
      `first account out in ${inDuration(forecast.firstRunsOutAtMs!)}; ` +
        `${inDuration(average.firstRunsOutAtMs!)} at window average`
    );
    expect(markup).toContain(
      `in ${inDuration(forecast.allOutAtMs!)}; ${inDuration(average.allOutAtMs!)} at window average`
    );
  });

  test('says which pace lasts when only one of them runs out', () => {
    const average = forecast.atWindowAverage!;
    const lastsRecently: QuotaForecast = { ...forecast, firstRunsOutAtMs: null, allOutAtMs: null };
    expect(rows(lastsRecently)).toContain(
      `lasts until next reset; out in ${inDuration(average.firstRunsOutAtMs!)} at window average`
    );
    const lastsOnAverage: QuotaForecast = {
      ...forecast,
      atWindowAverage: { ...average, firstRunsOutAtMs: null, allOutAtMs: null },
    };
    expect(rows(lastsOnAverage)).toContain(
      `first account out in ${inDuration(forecast.firstRunsOutAtMs!)}; lasts at window average`
    );
  });

  test('shows only the recent figures when there is no window-average projection', () => {
    const fallback = build([]);
    expect(fallback.atWindowAverage).toBeNull();
    expect(rows(fallback)).not.toContain('window average');
  });
});

test('the window-average strings exist in all six locales', async () => {
  const placeholders: Record<string, string[]> = {
    forecast_legend_recent_pace: [],
    forecast_legend_window_average: [],
    pace_with_window_average: ['{{recent}}', '{{average}}'],
    pace_at_window_average: ['{{duration}}'],
    pace_out_at_window_average: ['{{duration}}'],
    pace_lasts_at_window_average: [],
  };
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
    const messages = (await Bun.file(`src/i18n/locales/${locale}.json`).json()).quota_management;
    for (const [key, needed] of Object.entries(placeholders)) {
      expect(typeof messages[key]).toBe('string');
      for (const placeholder of needed) expect(messages[key]).toContain(placeholder);
    }
  }
});
