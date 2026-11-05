import React from 'react';
import styles from './InvoicesPage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import type { InvoiceSummary } from '../../types/domain.ts';
import { daysUntil, dueBadge, formatDueDate, formatMoney, invoiceTotal } from './invoice.ts';

/** Factures de la session, chargées par le Dashboard (qui en tire aussi la pastille « À payer »). */
export type InvoiceState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; invoice: InvoiceSummary };

interface InvoicesPageProps {
  state: InvoiceState;
  onRetry: () => void;
  /** Page de l'établissement qui explique comment payer. Absente : bouton grisé, à venir. */
  paymentInfoUrl?: string;
  /** Aujourd'hui, pour le compte à rebours de l'échéance. */
  now?: Date;
}

interface BalanceProps {
  invoice: InvoiceSummary;
  now: Date;
  paymentInfoUrl?: string;
}

function Balance({ invoice, now, paymentInfoUrl }: BalanceProps): React.ReactElement {
  const total = invoiceTotal(invoice);

  if (total <= 0) {
    return (
      <div className={styles.summary}>
        <div className={styles.balance}>
          <p className={styles.balanceLabel}>Solde à payer</p>
          <p className={styles.amount}>{formatMoney(0)}</p>
          <p className={styles.due}>
            <span className={`${styles.badge} ${styles.badgePaid}`}>Rien à payer</span>
            Aucun montant dû pour la session d'{invoice.session}.
          </p>
        </div>
      </div>
    );
  }

  const badge = invoice.dueDate ? dueBadge(daysUntil(invoice.dueDate, now)) : null;
  return (
    <>
      <div className={styles.summary}>
        <div className={styles.balance}>
          <p className={styles.balanceLabel}>Solde à payer</p>
          <p className={styles.amount}>{formatMoney(total)}</p>
          {invoice.dueDate && badge && (
            <p className={styles.due}>
              Échéance le {formatDueDate(invoice.dueDate)}
              <span
                className={`${styles.badge} ${badge.tone === 'late' ? styles.badgeLate : styles.badgeSoon}`}
              >
                {badge.text}
              </span>
            </p>
          )}
        </div>
        {/* Le paiement se fait chez l'établissement : on renvoie à sa page d'explications. */}
        {paymentInfoUrl ? (
          <a
            className={`${styles.button} ${styles.primary}`}
            href={paymentInfoUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Comment payer
          </a>
        ) : (
          <button
            type="button"
            className={`${styles.button} ${styles.primary} ${styles.soon}`}
            aria-disabled="true"
            title="Bientôt disponible"
          >
            Comment payer
          </button>
        )}
      </div>

      <table className={styles.lines}>
        <caption className={styles.srOnly}>Détail des montants dus</caption>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.label}>
              <th scope="row">
                <span className={styles.lineLabel}>{line.label}</span>
                {line.detail && <span className={styles.lineDetail}>{line.detail}</span>}
              </th>
              <td>{formatMoney(line.amountCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total à payer</th>
            <td>{formatMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

/**
 * Page Factures du portail (#207) : ce que l'étudiant doit pour la session, sans plus.
 * Le paiement se fait chez l'établissement : « Comment payer » renvoie à ses explications.
 */
export default function InvoicesPage({
  state,
  onRetry,
  paymentInfoUrl,
  now = new Date(),
}: InvoicesPageProps): React.ReactElement {
  return (
    <section className={styles.page} aria-label="Contenu principal">
      <div className={styles.main}>
        <div>
          <h1 className={styles.title}>Factures</h1>
          <p className={styles.subtitle}>
            {state.status === 'ready'
              ? `Ce que vous devez pour la session d'${state.invoice.session}`
              : 'Ce que vous devez pour la session'}
          </p>
        </div>

        <div className={styles.card}>
          {state.status === 'loading' ? (
            <div className={styles.state} role="status" aria-busy="true">
              <Spinner size={24} />
              <span>Chargement de vos factures…</span>
            </div>
          ) : state.status === 'error' ? (
            <div className={styles.state} role="alert">
              <span>Impossible de charger vos factures.</span>
              <button type="button" className={styles.button} onClick={onRetry}>
                Réessayer
              </button>
            </div>
          ) : (
            <Balance invoice={state.invoice} now={now} paymentInfoUrl={paymentInfoUrl} />
          )}
        </div>
      </div>
    </section>
  );
}
