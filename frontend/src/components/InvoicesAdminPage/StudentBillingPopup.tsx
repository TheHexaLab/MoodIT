import React from 'react';
import shared from './InvoicesAdminPage.module.css';
import styles from './StudentBillingPopup.module.css';
import { Popup } from '../Popup/Popup';
import { PopupVariant } from '../Popup/popupVariant';
import { usePopupController } from '../Popup/popupController';
import type { EnrolledStudent, FeeSchedule, InvoiceLine } from '../../types/domain.ts';
import {
  creditsLabel,
  daysUntil,
  formatDueDate,
  formatMoney,
  INTEREST_LABEL,
  statusLabel,
} from '../InvoicesPage/invoice.ts';
import { billingRow, PAYMENT_LABELS, type PaymentState } from './billing.ts';
import { STATE_BADGE } from './stateBadge.ts';

const WIDTH = { '--popup-width': '40rem' } as React.CSSProperties;

/** Couleur du solde selon l'état : à payer (jaune), en retard (rouge), payée (vert). */
const BALANCE_TONE: Record<PaymentState, string> = {
  due: styles.toneDue,
  partial: styles.toneDue,
  late: styles.toneLate,
  paid: styles.tonePaid,
  none: styles.tonePaid,
};

/** « CL » pour Camille Lavoie. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

/** Une ligne de la facture : libellé et précision à gauche, montant à droite. */
function Line({ line, tone }: { line: InvoiceLine; tone?: string }): React.ReactElement {
  return (
    <li className={styles.line}>
      <span className={styles.lineText}>
        <span className={styles.lineLabel}>{line.label}</span>
        {line.detail && <span className={styles.lineDetail}>{line.detail}</span>}
      </span>
      <span className={`${styles.amount} ${tone ?? ''}`}>{formatMoney(line.amountCents)}</span>
    </li>
  );
}

interface StudentBillingPopupProps {
  student: EnrolledStudent;
  schedule: FeeSchedule;
  now: Date;
  onClose: () => void;
}

/**
 * Détail de la facture d'un étudiant, en consultation : le total, ce qui est payé et le solde en un
 * coup d'œil, puis le détail par groupe (droits de scolarité, frais, intérêts, paiements reçus).
 * Les paiements arrivent de l'établissement ; on ne les saisit pas ici.
 */
export function StudentBillingPopup({
  student,
  schedule,
  now,
  onClose,
}: StudentBillingPopupProps): React.ReactElement {
  const popup = usePopupController();
  const row = billingRow(schedule, student, now);
  const [tuition, ...rest] = row.invoice.lines;
  const fees = rest.filter((line) => line.label !== INTEREST_LABEL);
  const interest = rest.filter((line) => line.label === INTEREST_LABEL);
  const feesTotal = fees.reduce((sum, line) => sum + line.amountCents, 0);
  const declined = schedule.fees.filter(
    (fee) => fee.optional && student.optedOut?.includes(fee.label)
  );
  const days = daysUntil(schedule.dueDate, now);
  const dueNote =
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

        {/* En un coup d'œil : le total, ce qui est payé, et le solde (en couleur selon l'état). */}
        <dl className={styles.summary}>
          <div className={styles.figure}>
            <dt>Total de la session</dt>
            <dd>{formatMoney(row.total)}</dd>
          </div>
          <div className={styles.figure}>
            <dt>Payé</dt>
            <dd className={row.paid > 0 ? styles.tonePaid : ''}>{formatMoney(row.paid)}</dd>
          </div>
          <div className={`${styles.figure} ${styles.balance} ${BALANCE_TONE[row.state]}`}>
            <dt>Solde</dt>
            <dd>{formatMoney(row.balance)}</dd>
            <span className={styles.figureNote}>{dueNote}</span>
          </div>
        </dl>

        <div className={styles.body}>
          <section aria-labelledby="bill-tuition">
            <h2 id="bill-tuition" className={styles.groupTitle}>
              Droits de scolarité
            </h2>
            <ul className={styles.group}>
              {/* « 9 crédits × 850,00 $ », au tarif de son statut. */}
              <Line
                line={{
                  label: tuition.detail ?? tuition.label,
                  detail: `Tarif : ${statusLabel(schedule, student.residency)}`,
                  amountCents: tuition.amountCents,
                }}
              />
            </ul>
          </section>

          {fees.length > 0 && (
            <section aria-labelledby="bill-fees">
              <h2 id="bill-fees" className={styles.groupTitle}>
                Frais de la session
                <span className={styles.groupTotal}>{formatMoney(feesTotal)}</span>
              </h2>
              <ul className={styles.group}>
                {fees.map((line) => (
                  <Line key={line.label} line={line} />
                ))}
              </ul>
              {declined.length > 0 && (
                <p className={styles.note}>
                  A refusé : {declined.map((fee) => fee.label).join(', ')}.
                </p>
              )}
            </section>
          )}

          {interest.length > 0 && (
            <section aria-labelledby="bill-interest">
              <h2 id="bill-interest" className={styles.groupTitle}>
                Intérêts
              </h2>
              <ul className={`${styles.group} ${styles.groupLate}`}>
                {interest.map((line) => (
                  <Line key={line.label} line={line} tone={styles.toneLate} />
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="bill-payments">
            <h2 id="bill-payments" className={styles.groupTitle}>
              Paiements reçus
              {student.payments.length > 0 && (
                <span className={styles.groupTotal}>−{formatMoney(row.paid)}</span>
              )}
            </h2>
            {student.payments.length === 0 ? (
              <p className={styles.empty}>Aucun paiement reçu pour l'instant.</p>
            ) : (
              <ul className={styles.group}>
                {student.payments.map((payment, index) => (
                  <Line
                    key={`${payment.date}-${index}`}
                    line={{
                      label: formatDueDate(payment.date),
                      detail: payment.method,
                      amountCents: payment.amountCents,
                    }}
                    tone={styles.tonePaid}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Popup>
  );
}
