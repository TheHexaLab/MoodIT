import React, { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import styles from './InvoicesPage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import InvoiceStatement from './InvoiceStatement.tsx';
import { InvoiceDetails, InvoiceFigures, type BalanceTone } from './InvoiceBreakdown.tsx';
import type { InvoiceSummary } from '../../types/domain.ts';
import {
  daysUntil,
  dueBadge,
  formatDueDate,
  formatMoney,
  INVOICE_LINKS,
  invoiceBalance,
  invoiceStatus,
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
  /**
   * TEMPORAIRE, développement seulement : boutons pour voir chaque état de la facture fictive.
   * Absent en production (les factures fictives n'y existent pas).
   */
  demoStates?: DemoStates;
}

/** Sélecteur d'état de la démo : l'état affiché, la liste, et le changement. */
export interface DemoStates {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
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

/** Le bouton « Comment payer » : la page de l'établissement, ou grisé tant qu'elle manque. */
function HowToPay({ url }: { url?: string }): React.ReactElement {
  return url ? (
    <a
      className={`${styles.button} ${styles.primary} ${styles.noPrint}`}
      href={url}
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
  );
}

/**
 * La facture de l'étudiant : en haut, le total, ce qui est payé et le solde (en couleur selon
 * l'état), avec l'échéance et « Comment payer » ; dessous, le détail par groupe.
 */
function Balance({ invoice, now, paymentInfoUrl }: BalanceProps): React.ReactElement {
  const total = invoiceTotal(invoice);
  const balance = invoiceBalance(invoice);

  if (total <= 0) {
    return (
      <div className={`${styles.card} ${styles.nothing}`}>
        <span className={`${styles.badge} ${styles.badgePaid}`}>Rien à payer</span>
        <p className={styles.amount}>{formatMoney(0)}</p>
        <p className={styles.nothingText}>Aucun montant dû pour la session d'{invoice.session}.</p>
      </div>
    );
  }

  const status = invoiceStatus(invoice, now);
  const lastPayment = lastPaymentDate(invoice);
  const days = invoice.dueDate ? daysUntil(invoice.dueDate, now) : null;
  const badge = days !== null ? dueBadge(days) : null;
  const tone: BalanceTone = status === 'paid' ? 'paid' : status === 'late' ? 'late' : 'due';
  // Payée : la date du dernier paiement sous le solde. Sinon, le compte à rebours est une
  // pastille à côté de l'échéance (« Dans 16 jours », « En retard de 12 jours »).
  const note =
    status === 'paid'
      ? lastPayment
        ? `Payée en entier le ${formatDueDate(lastPayment)}`
        : 'Payée en entier'
      : undefined;
  const pill =
    status === 'late' && days !== null
      ? { text: `En retard de ${-days} ${-days > 1 ? 'jours' : 'jour'}`, late: true }
      : badge && { text: badge.text, late: badge.tone === 'late' };

  return (
    <>
      <div className={`${styles.card} ${styles.hero}`}>
        <InvoiceFigures balance={balance} tone={tone} note={note} />
        <div className={styles.heroFooter}>
          {status === 'paid' ? (
            <p className={styles.due}>Merci! Votre facture de la session est réglée.</p>
          ) : (
            <>
              <p className={styles.due}>
                {invoice.dueDate
                  ? `Échéance le ${formatDueDate(invoice.dueDate)}`
                  : 'Aucune échéance fixée'}
                {pill && (
                  <span
                    className={`${styles.badge} ${pill.late ? styles.badgeLate : styles.badgeSoon}`}
                  >
                    {pill.text}
                  </span>
                )}
              </p>
              <HowToPay url={paymentInfoUrl} />
            </>
          )}
        </div>
      </div>

      <div className={`${styles.card} ${styles.detailsCard}`}>
        <InvoiceDetails lines={invoice.lines} payments={invoice.payments ?? []} />
      </div>
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
  demoStates,
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

        {/* TEMPORAIRE : voir chaque état de la facture fictive (développement seulement). */}
        {demoStates && (
          <div
            className={`${styles.demo} ${styles.noPrint}`}
            role="group"
            aria-label="État de la démo"
          >
            <span className={styles.demoLabel}>Démo, temporaire</span>
            {demoStates.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.demoChip} ${option.value === demoStates.value ? styles.demoChipOn : ''}`}
                aria-pressed={option.value === demoStates.value}
                onClick={() => demoStates.onChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {state.status === 'loading' ? (
          <div className={`${styles.card} ${styles.state}`} role="status" aria-busy="true">
            <Spinner size={24} />
            <span>Chargement de vos factures…</span>
          </div>
        ) : state.status === 'error' ? (
          <div className={`${styles.card} ${styles.state}`} role="alert">
            <span>Impossible de charger vos factures.</span>
            <button type="button" className={styles.button} onClick={onRetry}>
              Réessayer
            </button>
          </div>
        ) : (
          <Balance invoice={state.invoice} now={now} paymentInfoUrl={paymentInfoUrl} />
        )}

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
