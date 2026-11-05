import React from 'react';
import styles from './InvoiceStatement.module.css';
import type { InvoiceSummary } from '../../types/domain.ts';
import { formatDay, formatDueDate, formatMoney, invoiceTotal } from './invoice.ts';

interface InvoiceStatementProps {
  invoice: InvoiceSummary;
  /** Nom complet de l'étudiant. */
  studentName?: string;
  /** Établissement émetteur, en tête du relevé. */
  establishmentName?: string;
  now: Date;
}

/** « automne 2026 » → « Automne 2026 ». */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Relevé de compte imprimable (« Enregistrer en PDF ») : invisible à l'écran, seul à l'impression.
 * Mise en page sobre, en noir sur blanc : en-tête, informations, détail des montants et solde.
 */
export default function InvoiceStatement({
  invoice,
  studentName,
  establishmentName,
  now,
}: InvoiceStatementProps): React.ReactElement {
  const total = invoiceTotal(invoice);
  const session = capitalize(invoice.session);

  return (
    <article className={styles.statement}>
      <header className={styles.top}>
        <div>
          <p className={styles.issuer}>{establishmentName?.trim() || 'Établissement'}</p>
          <p className={styles.muted}>Relevé produit avec MoodIT</p>
        </div>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>Relevé de compte</h2>
          <p className={styles.muted}>Session {invoice.session}</p>
        </div>
      </header>

      <dl className={styles.facts}>
        <div>
          <dt>Étudiant</dt>
          <dd>{studentName?.trim() || '—'}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{session}</dd>
        </div>
        <div>
          <dt>Date du relevé</dt>
          <dd>{formatDay(now)}</dd>
        </div>
        <div>
          <dt>Échéance</dt>
          <dd>{invoice.dueDate && total > 0 ? formatDueDate(invoice.dueDate) : '—'}</dd>
        </div>
      </dl>

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Montant</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.length === 0 ? (
            <tr>
              <td colSpan={2} className={styles.empty}>
                Aucun montant dû pour cette session.
              </td>
            </tr>
          ) : (
            invoice.lines.map((line) => (
              <tr key={line.label}>
                <td>
                  {line.label}
                  {line.detail && <span className={styles.detail}>{line.detail}</span>}
                </td>
                <td>{formatMoney(line.amountCents)}</td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td>{formatMoney(total)}</td>
          </tr>
        </tfoot>
      </table>

      <section className={styles.balance}>
        <div>
          <p className={styles.balanceLabel}>Solde à payer</p>
          {invoice.dueDate && total > 0 && (
            <p className={styles.muted}>Avant le {formatDueDate(invoice.dueDate)}</p>
          )}
        </div>
        <p className={styles.balanceAmount}>{formatMoney(Math.max(total, 0))}</p>
      </section>

      <footer className={styles.footer}>
        <p>
          Ce relevé indique les montants dus pour la session {invoice.session}. Il ne constitue pas
          un reçu officiel.
        </p>
        <p>Produit le {formatDay(now)}.</p>
      </footer>
    </article>
  );
}
