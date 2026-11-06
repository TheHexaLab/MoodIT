import React from 'react';
import shared from './InvoicesAdminPage.module.css';
import styles from './StudentBillingPopup.module.css';
import { Popup } from '../Popup/Popup';
import { PopupVariant } from '../Popup/popupVariant';
import { usePopupController } from '../Popup/popupController';
import {
  InvoiceDetails,
  InvoiceFigures,
  type BalanceTone,
} from '../InvoicesPage/InvoiceBreakdown.tsx';
import type { EnrolledStudent, FeeSchedule } from '../../types/domain.ts';
import { creditsLabel, daysUntil, formatDueDate, statusLabel } from '../InvoicesPage/invoice.ts';
import { billingRow, PAYMENT_LABELS } from './billing.ts';
import { STATE_BADGE } from './stateBadge.ts';

const WIDTH = { '--popup-width': '40rem' } as React.CSSProperties;

/** « CL » pour Camille Lavoie. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

interface StudentBillingPopupProps {
  student: EnrolledStudent;
  schedule: FeeSchedule;
  now: Date;
  onClose: () => void;
}

/**
 * Détail de la facture d'un étudiant, en consultation : le total, ce qui est payé et le solde en un
 * coup d'œil, puis le détail par groupe (droits de scolarité, frais, intérêts, paiements reçus),
 * comme sur la page de l'étudiant. Les paiements arrivent de l'établissement ; on ne les saisit pas.
 */
export function StudentBillingPopup({
  student,
  schedule,
  now,
  onClose,
}: StudentBillingPopupProps): React.ReactElement {
  const popup = usePopupController();
  const row = billingRow(schedule, student, now);
  const declined = schedule.fees.filter(
    (fee) => fee.optional && student.optedOut?.includes(fee.label)
  );
  const days = daysUntil(schedule.dueDate, now);
  const tone: BalanceTone = row.state === 'late' ? 'late' : row.balance <= 0 ? 'paid' : 'due';
  const note =
    row.balance <= 0
      ? row.paid > 0
        ? 'Payée en entier'
        : 'Rien à payer'
      : days < 0
        ? `En retard de ${-days} ${-days > 1 ? 'jours' : 'jour'}`
        : `Échéance le ${formatDueDate(schedule.dueDate)}`;

  return (
    <Popup
      variant={PopupVariant.FormWide}
      label={`Facture de ${student.name}`}
      onClose={onClose}
      controller={popup}
      panelStyle={WIDTH}
    >
      <div className={styles.popup}>
        <header className={styles.header}>
          <span className={styles.avatar} aria-hidden="true">
            {initials(student.name)}
          </span>
          <div className={styles.identity}>
            <h1>{student.name}</h1>
            <p>
              {[student.studentNumber, student.program, student.email].filter(Boolean).join(' · ')}
            </p>
            <div className={styles.tags}>
              <span className={`${shared.badge} ${STATE_BADGE[row.state]}`}>
                {PAYMENT_LABELS[row.state]}
              </span>
              <span className={styles.tag}>{statusLabel(schedule, student.residency)}</span>
              <span className={styles.tag}>{creditsLabel(student.credits)}</span>
            </div>
          </div>
          <button
            type="button"
            className={shared.close}
            aria-label="Fermer"
            onClick={() => popup.requestClose(onClose)}
          >
            ✕
          </button>
        </header>

        <div className={styles.figures}>
          <InvoiceFigures balance={row.balance} tone={tone} note={note} />
        </div>

        <div className={styles.body}>
          <InvoiceDetails
            lines={row.invoice.lines}
            payments={student.payments}
            tuitionNote={`Tarif : ${statusLabel(schedule, student.residency)}`}
            feesNote={
              declined.length > 0
                ? `A refusé : ${declined.map((fee) => fee.label).join(', ')}.`
                : undefined
            }
          />
        </div>
      </div>
    </Popup>
  );
}
