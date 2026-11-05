import React, { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import styles from './InvoicesPage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import InvoiceStatement from './InvoiceStatement.tsx';
import type { InvoicePayment, InvoiceSummary } from '../../types/domain.ts';
import {
  daysUntil,
  dueBadge,
  formatDueDate,
  formatMoney,
  INVOICE_LINKS,
  invoiceBalance,
  invoicePaid,
  invoiceTotal,
  lastPaymentDate,
  type InvoiceLink,
} from './invoice.ts';

/** Factures de la session, chargées par le Dashboard (qui en tire aussi la pastille « À payer »). */
export type InvoiceState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; invoice: InvoiceSummary };

const EXTERNAL_ICON = 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5';

interface InvoicesPageProps {
  state: InvoiceState;
  onRetry: () => void;
  /** Page de l'établissement qui explique comment payer. Absente : bouton grisé, à venir. */
  paymentInfoUrl?: string;
  /** Liens complémentaires, sous la facture. */
  links?: InvoiceLink[];
  /** Nom complet de l'étudiant, sur le relevé PDF. */
  studentName?: string;
  /** Établissement émetteur, en tête du relevé PDF. */
  establishmentName?: string;
  /** Aujourd'hui, pour le compte à rebours de l'échéance. */
  now?: Date;
}

function LinkRow({ link }: { link: InvoiceLink }): React.ReactElement {
  const icon = (
    <svg className={styles.linkIcon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={EXTERNAL_ICON}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
  return link.url ? (
    <a className={styles.link} href={link.url} target="_blank" rel="noopener noreferrer">
      <span>{link.label}</span>
      {icon}
    </a>
  ) : (
    <span
      className={`${styles.link} ${styles.soon}`}
      aria-disabled="true"
      title="Bientôt disponible"
    >
      <span>{link.label}</span>
      {icon}
    </span>
  );
}

interface BalanceProps {
  invoice: InvoiceSummary;
  now: Date;
  paymentInfoUrl?: string;
}

/** « 3 novembre 2026 · Carte de crédit » : quand et comment un paiement a été reçu. */
function paymentDetail(payment: InvoicePayment): string {
  return [formatDueDate(payment.date), payment.method].filter(Boolean).join(' · ');
}

function Balance({ invoice, now, paymentInfoUrl }: BalanceProps): React.ReactElement {
  const total = invoiceTotal(invoice);
  const paid = invoicePaid(invoice);
  const balance = invoiceBalance(invoice);
  const payments = invoice.payments ?? [];

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

  const paidOff = balance <= 0;
  const lastPayment = lastPaymentDate(invoice);
  const badge = invoice.dueDate ? dueBadge(daysUntil(invoice.dueDate, now)) : null;
  return (
    <>
      <div className={styles.summary}>
        <div className={styles.balance}>
          <p className={styles.balanceLabel}>Solde à payer</p>
          <p className={styles.amount}>{formatMoney(balance)}</p>
          {paidOff ? (
            // Payée : la date du dernier paiement remplace l'échéance.
            <p className={styles.due}>
              <span className={`${styles.badge} ${styles.badgePaid}`}>Payée</span>
              {lastPayment
                ? `Payée en entier le ${formatDueDate(lastPayment)}. Merci!`
                : 'Payée en entier. Merci!'}
            </p>
          ) : (
            invoice.dueDate &&
            badge && (
              <p className={styles.due}>
                Échéance le {formatDueDate(invoice.dueDate)}
                <span
                  className={`${styles.badge} ${badge.tone === 'late' ? styles.badgeLate : styles.badgeSoon}`}
                >
                  {badge.text}
                </span>
              </p>
            )
          )}
          {!paidOff && paid > 0 && (
            <p className={styles.paidNote}>
              {formatMoney(paid)} déjà reçu sur {formatMoney(total)}
            </p>
          )}
        </div>
        {/* Le paiement se fait chez l'établissement : on renvoie à sa page d'explications. */}
        {!paidOff &&
          (paymentInfoUrl ? (
            <a
              className={`${styles.button} ${styles.primary} ${styles.noPrint}`}
              href={paymentInfoUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Comment payer
            </a>
          ) : (
            <button
              type="button"
              className={`${styles.button} ${styles.primary} ${styles.soon} ${styles.noPrint}`}
              aria-disabled="true"
              title="Bientôt disponible"
            >
              Comment payer
            </button>
          ))}
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
        {payments.length > 0 && (
          // Paiements reçus : le total, puis chaque paiement en déduction.
          <tbody className={styles.payments}>
            <tr className={styles.subtotal}>
              <th scope="row">Total</th>
              <td>{formatMoney(total)}</td>
            </tr>
            {payments.map((payment, index) => (
              <tr key={`${payment.date}-${index}`}>
                <th scope="row">
                  <span className={styles.lineLabel}>Paiement reçu</span>
                  <span className={styles.lineDetail}>{paymentDetail(payment)}</span>
                </th>
                <td className={styles.credit}>−{formatMoney(payment.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        )}
        <tfoot>
          <tr>
            <th scope="row">{payments.length > 0 ? 'Solde à payer' : 'Total à payer'}</th>
            <td>{formatMoney(balance)}</td>
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
  links = INVOICE_LINKS,
  studentName,
  establishmentName,
  now = new Date(),
}: InvoicesPageProps): React.ReactElement {
  // Le relevé n'existe que le temps d'imprimer (bouton ou Ctrl+P) : à l'écran et pour les lecteurs
  // d'écran, la page seule, sans doublon. flushSync : le relevé est rendu avant la mise en page.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  const statementShown = printing && state.status === 'ready';

  return (
    <section
      className={`${styles.page} ${statementShown ? styles.printing : ''}`}
      aria-label="Contenu principal"
    >
      <div className={styles.main}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Factures</h1>
            <p className={styles.subtitle}>
              {state.status === 'ready'
                ? `Ce que vous devez pour la session d'${state.invoice.session}`
                : 'Ce que vous devez pour la session'}
            </p>
          </div>
          {state.status === 'ready' && (
            // La fenêtre d'impression du navigateur propose « Enregistrer au format PDF » ; elle
            // n'imprime que le relevé ci-dessous (InvoiceStatement), pas la page.
            <button
              type="button"
              className={`${styles.button} ${styles.noPrint}`}
              onClick={() => window.print()}
            >
              <svg className={styles.buttonIcon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 4v11M7 10l5 5 5-5M5 20h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Enregistrer en PDF
            </button>
          )}
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

        {links.length > 0 && (
          <nav
            className={`${styles.card} ${styles.linksCard} ${styles.noPrint}`}
            aria-labelledby="invoice-links-title"
          >
            <h2 className={styles.linksTitle} id="invoice-links-title">
              Liens complémentaires
            </h2>
            <ul className={styles.links}>
              {links.map((link) => (
                <li key={link.label}>
                  <LinkRow link={link} />
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>

      {statementShown && (
        <InvoiceStatement
          invoice={state.invoice}
          studentName={studentName}
          establishmentName={establishmentName}
          now={now}
        />
      )}
    </section>
  );
}
