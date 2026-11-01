/**
 * Whether CLIProxyAPI is routing requests to a credential, read from the
 * auth-files listing the page already polls:
 * - disabled: switched off;
 * - cooling: a credential-wide cooldown is running, or the listing marks the
 *   credential unavailable without one;
 * - serving: available, with successful requests in the newest or previous
 *   10-minute bucket of `recent_requests`;
 * - standby: available, with no recent successes.
 *
 * Cooldown deadlines count from when the listing arrived (`remaining_seconds`),
 * never from the local clock against `retry_at`; `retry_at` is only compared
 * with quota reset instants, which come from the same upstream clock. Pure:
 * `nowMs` is passed in, so a cooldown clears on the next tick after it ends.
 */

import type { TFunction } from 'i18next';
import type { AuthFileCooldown, AuthFileItem } from '@/types';
import { MINUTE_MS } from '@/utils/time/durations';
import { cooldownReasonKey } from '@/features/authFiles/cooldowns';
import { formatClockOrWeekday } from './display';
import type { QuotaMeterReading } from './forecast/quotaMeters';

export type RoutingState = 'disabled' | 'cooling' | 'serving' | 'standby';

/** What the cooldown is about, when the listing and the quota readings can tell. */
export type CooldownLimit = 'five_hour' | 'weekly' | 'rate_limited' | 'other';

export interface CredentialCooldown {
  /** Local instant it ends; null when the listing marks the credential unavailable without a timer. */
  untilMs: number | null;
  /** Upstream reason, e.g. `credential_quota`; null when there is no cooldown record. */
  reason: string | null;
  limit: CooldownLimit;
  /** The quota meter whose window ran out (it shows "out until"), when known. */
  meterId: string | null;
}

export interface RoutingStatus {
  state: RoutingState;
  /** Set when `state` is `cooling`. */
  cooldown: CredentialCooldown | null;
  /** Model-only cooldowns while the credential itself is not cooling. */
  models: { count: number; untilMs: number } | null;
  priority: number | null;
  /** Requests (successful and failed) in the newest 10-minute bucket. */
  recentRequests: number;
}

/** `retry_at` this close to a window's reset means that window ran out. */
export const RESET_MATCH_MS = 5 * MINUTE_MS;
/** A reading at or above this many percent used is "at or near the limit". */
export const NEAR_LIMIT_USED_PERCENT = 90;

const QUOTA_REASONS = new Set(['credential_quota', 'quota']);

const endOf = (record: AuthFileCooldown, receivedAtMs: number) =>
  receivedAtMs + record.remainingSeconds * 1000;

/** Anthropic's `representative-claim` header from the passive snapshot, e.g. `five_hour`. */
export function representativeClaim(file: AuthFileItem): string | null {
  const signals = (file.quota as { signals?: unknown } | undefined)?.signals;
  if (!signals || typeof signals !== 'object') return null;
  const entry = Object.entries(signals as Record<string, unknown>).find(
    ([name]) => name.toLowerCase() === 'anthropic-ratelimit-unified-representative-claim'
  );
  return typeof entry?.[1] === 'string' && entry[1].trim() ? entry[1].trim().toLowerCase() : null;
}

const fiveHourMeter = (meters: QuotaMeterReading[]) =>
  meters.find((meter) => meter.id === 'five-hour') ??
  meters.find((meter) => meter.periodHours === 5);

const weeklyMeter = (meters: QuotaMeterReading[]) =>
  meters.find((meter) => meter.primary) ??
  meters.find((meter) => (meter.periodHours ?? 0) >= 24 * 7);

const nearLimit = (meter: QuotaMeterReading | undefined) =>
  meter !== undefined && 100 - meter.remaining >= NEAR_LIMIT_USED_PERCENT;

/** Names the limit behind a credential-wide cooldown and the window it emptied. */
function describeCooldown(
  record: AuthFileCooldown | null,
  file: AuthFileItem,
  meters: QuotaMeterReading[]
): Pick<CredentialCooldown, 'limit' | 'meterId'> {
  const fiveHour = fiveHourMeter(meters);
  const weekly = weeklyMeter(meters);
  const claim = representativeClaim(file);
  const quotaRelated = record
    ? QUOTA_REASONS.has(record.reason) || record.httpStatus === 429
    : /429|rate.?limit/i.test(String(file.statusMessage ?? ''));

  const retryAtMs = record ? Date.parse(record.retryAt) : NaN;
  const matched = Number.isFinite(retryAtMs)
    ? [fiveHour, weekly].find(
        (meter) =>
          meter?.resetAtMs !== null &&
          meter?.resetAtMs !== undefined &&
          Math.abs(meter.resetAtMs - retryAtMs) <= RESET_MATCH_MS
      )
    : undefined;
  if (matched) {
    return { limit: matched === fiveHour ? 'five_hour' : 'weekly', meterId: matched.id };
  }
  if (claim === 'five_hour') return { limit: 'five_hour', meterId: fiveHour?.id ?? null };
  if (claim?.startsWith('seven_day')) return { limit: 'weekly', meterId: weekly?.id ?? null };
  if (quotaRelated && nearLimit(fiveHour)) return { limit: 'five_hour', meterId: null };
  if (quotaRelated && nearLimit(weekly)) return { limit: 'weekly', meterId: null };
  return { limit: quotaRelated ? 'rate_limited' : 'other', meterId: null };
}

/**
 * Routing status of one credential at `nowMs`.
 * `meters` are its raw quota readings (not advanced to `nowMs`): the reading
 * taken before the cooldown is what tells which window ran out.
 */
export function credentialRoutingStatus(
  file: AuthFileItem,
  meters: QuotaMeterReading[],
  nowMs: number
): RoutingStatus {
  const snapshot = file.cooldownSnapshot;
  const records = snapshot?.records ?? [];
  const receivedAtMs = snapshot?.receivedAtMs ?? nowMs;
  const credentialRecords = records.filter((record) => record.scope === 'credential');
  const activeCredential = credentialRecords
    .filter((record) => endOf(record, receivedAtMs) > nowMs)
    .sort((a, b) => endOf(b, receivedAtMs) - endOf(a, receivedAtMs))[0];
  const activeModels = records.filter(
    (record) => record.scope === 'model' && endOf(record, receivedAtMs) > nowMs
  );
  const buckets = file.recentRequests ?? [];
  const newest = buckets[buckets.length - 1];
  const previous = buckets[buckets.length - 2];
  const priority =
    typeof file.priority === 'number' && Number.isFinite(file.priority) ? file.priority : null;
  const base = {
    priority,
    recentRequests: newest ? newest.success + newest.failed : 0,
  };

  // A credential timer that has run out also ends the "unavailable" it caused;
  // the next listing confirms it.
  const unavailable = file.unavailable === true && credentialRecords.length === 0;
  let state: RoutingState;
  let cooldown: CredentialCooldown | null = null;
  if (file.disabled === true) {
    state = 'disabled';
  } else if (activeCredential || unavailable) {
    state = 'cooling';
    cooldown = {
      untilMs: activeCredential ? endOf(activeCredential, receivedAtMs) : null,
      reason: activeCredential?.reason ?? null,
      ...describeCooldown(activeCredential ?? null, file, meters),
    };
  } else {
    state = (newest?.success ?? 0) > 0 || (previous?.success ?? 0) > 0 ? 'serving' : 'standby';
  }

  return {
    state,
    cooldown,
    models:
      state !== 'cooling' && activeModels.length > 0
        ? {
            count: activeModels.length,
            untilMs: Math.max(...activeModels.map((record) => endOf(record, receivedAtMs))),
          }
        : null,
    ...base,
  };
}

/** The meter shown as "out until" instead of a pace forecast, with when it is back. */
export function outUntilFor(status: RoutingStatus, meterId: string): number | null {
  const cooldown = status.cooldown;
  return cooldown && cooldown.meterId === meterId && cooldown.untilMs !== null
    ? cooldown.untilMs
    : null;
}

export interface RoutingText {
  /** "Serving", "Cooling down until 8:10 PM", ... */
  state: string;
  /** Why it is cooling, the newest bucket's request count, the priority. */
  details: string[];
  /** "3 models cooling down until 8:12 PM", when only models are cooling. */
  models: string | null;
}

const LIMIT_KEYS: Record<Exclude<CooldownLimit, 'other'>, string> = {
  five_hour: 'quota_management.routing_limit_five_hour',
  weekly: 'quota_management.routing_limit_weekly',
  rate_limited: 'quota_management.routing_limit_rate_limited',
};

/** The routing status as display text. */
export function routingText(
  t: TFunction,
  status: RoutingStatus,
  nowMs: number,
  language?: string
): RoutingText {
  const time = (ms: number) => formatClockOrWeekday(ms, nowMs, language);
  const cooldown = status.cooldown;
  const state =
    status.state === 'cooling'
      ? cooldown?.untilMs
        ? t('quota_management.routing_cooling_until', { time: time(cooldown.untilMs) })
        : t('quota_management.routing_cooling')
      : t(`quota_management.routing_${status.state}`);
  const details: string[] = [];
  if (cooldown) {
    if (cooldown.limit !== 'other') details.push(t(LIMIT_KEYS[cooldown.limit]));
    else if (cooldown.reason) details.push(t(cooldownReasonKey(cooldown.reason)));
  }
  if (status.state !== 'disabled' && status.recentRequests > 0) {
    details.push(t('quota_management.routing_requests', { requests: status.recentRequests }));
  }
  if (status.priority !== null) {
    details.push(t('quota_management.routing_priority', { priority: status.priority }));
  }
  return {
    state,
    details,
    models: status.models
      ? t('quota_management.routing_models_until', {
          models: t('auth_files.cooldown_models', { count: status.models.count }),
          time: time(status.models.untilMs),
        })
      : null,
  };
}

/** "Out until 8:10 PM (limit reached)" for the window a cooldown emptied. */
export const formatOutUntil = (t: TFunction, untilMs: number, nowMs: number, language?: string) =>
  t('quota_management.out_until', { time: formatClockOrWeekday(untilMs, nowMs, language) });

/**
 * Splits credentials for a provider summary: those CLIProxyAPI can route to,
 * and those cooling down. A cooling credential's last reading predates its
 * cooldown, so it must not count as capacity; the summary names it instead.
 */
export function partitionForForecast<T extends { file: AuthFileItem }>(
  entries: T[],
  metersFor: (entry: T) => QuotaMeterReading[],
  nowMs: number
): { usable: T[]; out: { entry: T; untilMs: number | null }[] } {
  const usable: T[] = [];
  const out: { entry: T; untilMs: number | null }[] = [];
  entries.forEach((entry) => {
    const status = credentialRoutingStatus(entry.file, metersFor(entry), nowMs);
    if (status.state === 'cooling') out.push({ entry, untilMs: status.cooldown?.untilMs ?? null });
    else usable.push(entry);
  });
  return { usable, out };
}
