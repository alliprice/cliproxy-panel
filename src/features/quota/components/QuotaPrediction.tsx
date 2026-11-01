/**
 * "If you continue at this rate" line for one quota window, at the window's
 * average burn rate: "Runs out in 2d 5h · Mon 26 Oct, 3:20 PM", or
 * "Lasts until reset · ~37% unused" (what is still unspent when it resets).
 * A window CLIProxyAPI has benched (`outUntilMs`) says when it is back instead:
 * its last reading predates the cooldown, so a pace would be fiction.
 */

import { useTranslation } from 'react-i18next';
import { windowBurn } from '../forecast/burnRate';
import type { QuotaMeterReading } from '../forecast/quotaMeters';
import type { ResolvedRate } from '../forecast/forecastWindows';
import { formatCompactDuration, formatOutlookTime, formatRate } from '../display';
import { formatOutUntil } from '../routing';
import styles from './QuotaPrediction.module.scss';

export interface QuotaPredictionProps {
  meter: QuotaMeterReading;
  nowMs: number;
  /** Prefix the burn rate; the ledger shows it on the reset line instead. */
  withRate?: boolean;
  /** Wrap to a second line rather than truncate (narrow ledger columns). */
  wrap?: boolean;
  /** The account's resolved rate (measured or window average); default: window average. */
  rate?: ResolvedRate;
  /** End of a credential cooldown that emptied this window; replaces the forecast. */
  outUntilMs?: number | null;
  className?: string;
}

export function QuotaPrediction({
  meter,
  nowMs,
  withRate = true,
  wrap = false,
  rate,
  outUntilMs = null,
  className,
}: QuotaPredictionProps) {
  const { t, i18n } = useTranslation();
  if (outUntilMs !== null) {
    const text = formatOutUntil(t, outUntilMs, nowMs, i18n.language);
    return (
      <span
        className={[styles.prediction, styles.exhausted, wrap ? styles.wrap : '', className ?? '']
          .filter(Boolean)
          .join(' ')}
        title={text}
      >
        {text}
      </span>
    );
  }
  const burn = rate ? windowBurn(meter, nowMs, rate.ratePerHour) : windowBurn(meter, nowMs);
  // Nothing to predict for an unknown window or an untouched one.
  if (burn.outcome === 'unknown' || (!burn.ratePerHour && meter.remaining >= 100)) return null;

  const ratePrefix = withRate && burn.ratePerHour ? `${formatRate(burn.ratePerHour)}/h · ` : '';
  const unused = Math.round(burn.unusedAtReset ?? 0);
  const text =
    burn.outcome === 'exhausted'
      ? t('quota_management.prediction_back', {
          duration: formatCompactDuration((burn.resetAtMs as number) - nowMs),
        })
      : burn.outcome === 'runs_out'
        ? `${ratePrefix}${t('quota_management.prediction_runs_out', {
            duration: formatCompactDuration((burn.runsOutAtMs as number) - nowMs),
            time: formatOutlookTime(burn.runsOutAtMs as number, i18n.language),
          })}`
        : `${ratePrefix}${
            unused >= 1
              ? t('quota_management.prediction_lasts_unused', { unused: `${unused}%` })
              : t('quota_management.prediction_lasts')
          }`;
  const tone =
    burn.outcome === 'lasts'
      ? styles.lasts
      : burn.outcome === 'runs_out'
        ? styles.runsOut
        : styles.exhausted;

  return (
    <span
      className={[styles.prediction, tone, wrap ? styles.wrap : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      title={text}
    >
      {text}
    </span>
  );
}
