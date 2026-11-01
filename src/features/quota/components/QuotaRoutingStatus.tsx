/**
 * The line a quota card leads with: whether CLIProxyAPI routes to the
 * credential (serving, standby, cooling down, disabled), then quieter notes
 * about the panel's own readings. The notes never take the status's place.
 */

import { useTranslation } from 'react-i18next';
import { routingText, type RoutingStatus } from '../routing';
import styles from './QuotaRoutingStatus.module.scss';

export interface QuotaRoutingStatusProps {
  status: RoutingStatus;
  nowMs: number;
  /** Secondary notes: usage check paused, setup token, reading age. */
  notes?: string[];
}

export function QuotaRoutingStatus({ status, nowMs, notes = [] }: QuotaRoutingStatusProps) {
  const { t, i18n } = useTranslation();
  const text = routingText(t, status, nowMs, i18n.language);
  return (
    <div className={styles.routing}>
      <p className={styles.line} data-state={status.state}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.state}>{text.state}</span>
      </p>
      {text.details.length > 0 && <p className={styles.details}>{text.details.join(' · ')}</p>}
      {text.models && <p className={styles.note}>{text.models}</p>}
      {notes.map((note) => (
        <p key={note} className={styles.note}>
          {note}
        </p>
      ))}
    </div>
  );
}
