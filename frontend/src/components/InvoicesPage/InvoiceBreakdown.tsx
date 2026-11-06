import React from 'react';
import styles from './InvoiceBreakdown.module.css';
import type { InvoiceLine, InvoicePayment } from '../../types/domain.ts';
import { formatDueDate, formatMoney, INTEREST_LABEL } from './invoice.ts';

/** État du solde : à payer (jaune), en retard (rouge), payé ou rien à payer (vert). */
export type BalanceTone = 'due' | 'late' | 'paid';

const TONE: Record<BalanceTone, string> = {
  due: styles.toneDue,
  late: styles.toneLate,
  paid: styles.tonePaid,
};

interface InvoiceFiguresProps {
  balance: number;
  tone: BalanceTone;
  /** Sous le solde : le compte à rebours, le retard, ou la date du dernier paiement. */
  note?: string;
  /** Nom de la tuile (par défaut « Solde restant »). */
  balanceLabel?: string;
}

/**
 * Une facture en un coup d'œil : le solde restant, dans la couleur de son état. Le total et les
 * paiements sont dans le détail, dessous. Partagé par la page de l'étudiant et le détail vu par
 * l'administration.
 */
export function InvoiceFigures({
  balance,
  tone,
  note,
  balanceLabel = 'Solde restant',
}: InvoiceFiguresProps): React.ReactElement {
  return (
    <dl className={styles.figures}>
      <div className={`${styles.figure} ${styles.balance} ${TONE[tone]}`}>
        <dt>{balanceLabel}</dt>
        <dd>{formatMoney(balance)}</dd>
        {note && <span className={styles.figureNote}>{note}</span>}
      </div>
    </dl>
  );
}

/** Une ligne : libellé et précision à gauche, montant à droite. */
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

interface InvoiceDetailsProps {
  lines: InvoiceLine[];
  payments: InvoicePayment[];
  /** Précision sous la ligne des droits de scolarité (« Tarif : International »). */
  tuitionNote?: string;
  /** Sous les frais : ceux que l'étudiant a refusés. */
  feesNote?: string;
}

/**
 * Le détail d'une facture, par groupe : droits de scolarité, frais de la session,
 * intérêts de retard s'il y en a, puis les paiements reçus.
 */
export function InvoiceDetails({
  lines,
  payments,
  tuitionNote,
  feesNote,
}: InvoiceDetailsProps): React.ReactElement {
  const tuition = lines.filter((line) => line.label === 'Droits de scolarité');
  const interest = lines.filter((line) => line.label === INTEREST_LABEL);
  const fees = lines.filter((line) => !tuition.includes(line) && !interest.includes(line));

  return (
    <div className={styles.details}>
      {tuition.length > 0 && (
        <section aria-labelledby="invoice-tuition">
          <h2 id="invoice-tuition" className={styles.groupTitle}>
            Droits de scolarité
          </h2>
          <ul className={styles.group}>
            {/* « 15 crédits × 105,00 $ » mis en avant ; le statut, s'il est connu, dessous. */}
            {tuition.map((line) => (
              <Line
                key={line.label}
                line={{
                  label: line.detail ?? line.label,
                  detail: tuitionNote,
                  amountCents: line.amountCents,
                }}
              />
            ))}
          </ul>
        </section>
      )}

      {fees.length > 0 && (
        <section aria-labelledby="invoice-fees">
          <h2 id="invoice-fees" className={styles.groupTitle}>
            Frais de la session
          </h2>
          <ul className={styles.group}>
            {fees.map((line) => (
              <Line key={line.label} line={line} />
            ))}
          </ul>
          {feesNote && <p className={styles.note}>{feesNote}</p>}
        </section>
      )}

      {interest.length > 0 && (
        <section className={styles.separated} aria-labelledby="invoice-interest">
          <h2 id="invoice-interest" className={styles.groupTitle}>
            Intérêts
          </h2>
          <ul className={styles.group}>
            {interest.map((line) => (
              <Line key={line.label} line={line} tone={styles.lateText} />
            ))}
          </ul>
        </section>
      )}

      <section className={styles.separated} aria-labelledby="invoice-payments">
        <h2 id="invoice-payments" className={styles.groupTitle}>
          Paiements reçus
        </h2>
        {payments.length === 0 ? (
          <p className={styles.empty}>Aucun paiement reçu pour l'instant.</p>
        ) : (
          <ul className={styles.group}>
            {payments.map((payment, index) => (
              <Line
                key={`${payment.date}-${index}`}
                line={{
                  label: formatDueDate(payment.date),
                  detail: payment.method,
                  amountCents: payment.amountCents,
                }}
                tone={styles.paidText}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
