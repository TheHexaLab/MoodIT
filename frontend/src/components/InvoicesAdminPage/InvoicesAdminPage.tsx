import React, { useCallback, useEffect, useState } from 'react';
import styles from './InvoicesAdminPage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import { NewInvoicePopup } from './NewInvoicePopup.tsx';
import type { InvoiceDraft, InvoicePayment, IssuedInvoice } from '../../types/domain.ts';
import {
  formatDueDate,
  formatMoney,
  invoiceBalance,
  invoicePaid,
  invoiceStatus,
  invoiceTotal,
  isoDay,
} from '../InvoicesPage/invoice.ts';

/** Accès aux factures émises : dashboardApi, données fictives en attendant une API. */
export interface InvoicesAdminApi {
  fetchIssued: () => Promise<IssuedInvoice[]>;
  create: (draft: InvoiceDraft) => Promise<IssuedInvoice>;
  recordPayment: (id: number, payment: InvoicePayment) => Promise<IssuedInvoice>;
}

interface InvoicesAdminPageProps {
  api: InvoicesAdminApi;
  /** « automne 2026 » : la session en cours. */
  session: string;
  /** Aujourd'hui : retards et date des paiements enregistrés. */
  now?: Date;
}

type ListState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; invoices: IssuedInvoice[] };

/** Pastille d'état d'une facture émise. */
function StatusBadge({ invoice, now }: { invoice: IssuedInvoice; now: Date }): React.ReactElement {
  const status = invoiceStatus(invoice, now);
  if (status === 'paid')
    return <span className={`${styles.badge} ${styles.badgePaid}`}>Payée</span>;
  if (status === 'late')
    return <span className={`${styles.badge} ${styles.badgeLate}`}>En retard</span>;
  if (invoicePaid(invoice) > 0) {
    return <span className={`${styles.badge} ${styles.badgePartial}`}>Paiement partiel</span>;
  }
  return <span className={`${styles.badge} ${styles.badgeDue}`}>À payer</span>;
}

/**
 * Factures, vue de l'administration (#207) : les factures émises pour la session, leurs totaux,
 * l'émission d'une nouvelle facture et l'enregistrement d'un paiement reçu.
 */
export default function InvoicesAdminPage({
  api,
  session,
  now = new Date(),
}: InvoicesAdminPageProps): React.ReactElement {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.fetchIssued().then(
      (invoices) => {
        if (!cancelled) setList({ status: 'ready', invoices });
      },
      () => {
        if (!cancelled) setList({ status: 'error' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  const retry = () => {
    setList({ status: 'loading' });
    setAttempt((value) => value + 1);
  };

  const create = useCallback(
    async (draft: InvoiceDraft) => {
      const invoice = await api.create(draft);
      setList((current) =>
        current.status === 'ready'
          ? { status: 'ready', invoices: [invoice, ...current.invoices] }
          : current
      );
      setNotice(`Facture émise à ${invoice.studentName}.`);
    },
    [api]
  );

  const markPaid = async (invoice: IssuedInvoice) => {
    try {
      const updated = await api.recordPayment(invoice.id, {
        date: isoDay(now),
        amountCents: invoiceBalance(invoice),
        method: "Enregistré par l'administration",
      });
      setList((current) =>
        current.status === 'ready'
          ? {
              status: 'ready',
              invoices: current.invoices.map((other) =>
                other.id === updated.id ? updated : other
              ),
            }
          : current
      );
      setNotice(`Paiement enregistré pour ${invoice.studentName}.`);
    } catch {
      setNotice("Le paiement n'a pas pu être enregistré. Réessayez.");
    }
  };

  const invoices = list.status === 'ready' ? list.invoices : [];
  const billed = invoices.reduce((sum, invoice) => sum + invoiceTotal(invoice), 0);
  const received = invoices.reduce((sum, invoice) => sum + invoicePaid(invoice), 0);
  const outstanding = invoices.reduce((sum, invoice) => sum + invoiceBalance(invoice), 0);
  const lateCount = invoices.filter((invoice) => invoiceStatus(invoice, now) === 'late').length;

  return (
    <section className={styles.page} aria-label="Contenu principal">
      <div className={styles.main}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Factures</h1>
            <p className={styles.subtitle}>Factures émises pour la session d'{session}</p>
          </div>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            disabled={list.status !== 'ready'}
            onClick={() => setCreating(true)}
          >
            + Nouvelle facture
          </button>
        </div>

        {/* Annonce des actions (facture émise, paiement enregistré) aux lecteurs d'écran. */}
        <p className={styles.notice} role="status">
          {notice}
        </p>

        {list.status === 'loading' ? (
          <div className={`${styles.card} ${styles.state}`} role="status" aria-busy="true">
            <Spinner size={24} />
            <span>Chargement des factures…</span>
          </div>
        ) : list.status === 'error' ? (
          <div className={`${styles.card} ${styles.state}`} role="alert">
            <span>Impossible de charger les factures.</span>
            <button type="button" className={styles.button} onClick={retry}>
              Réessayer
            </button>
          </div>
        ) : (
          <>
            <dl className={styles.stats}>
              <div className={styles.card}>
                <dt>Facturé</dt>
                <dd>
                  <span className={styles.statValue}>{formatMoney(billed)}</span>
                  <span className={styles.statNote}>
                    {invoices.length} {invoices.length > 1 ? 'factures' : 'facture'}
                  </span>
                </dd>
              </div>
              <div className={styles.card}>
                <dt>Reçu</dt>
                <dd>
                  <span className={styles.statValue}>{formatMoney(received)}</span>
                  <span className={styles.statNote}>
                    {billed > 0 ? Math.round((received / billed) * 100) : 0} % du total
                  </span>
                </dd>
              </div>
              <div className={styles.card}>
                <dt>À recevoir</dt>
                <dd>
                  <span className={styles.statValue}>{formatMoney(outstanding)}</span>
                  <span className={`${styles.statNote} ${lateCount > 0 ? styles.statLate : ''}`}>
                    {lateCount > 0 ? `${lateCount} en retard` : 'Aucune facture en retard'}
                  </span>
                </dd>
              </div>
            </dl>

            <div className={`${styles.card} ${styles.tableCard}`}>
              {invoices.length === 0 ? (
                <p className={styles.empty}>Aucune facture émise pour cette session.</p>
              ) : (
                <div className={styles.scroll}>
                  <table className={styles.table}>
                    <caption className={styles.srOnly}>Factures émises</caption>
                    <thead>
                      <tr>
                        <th scope="col">Étudiant</th>
                        <th scope="col">Échéance</th>
                        <th scope="col">Montant</th>
                        <th scope="col">Solde</th>
                        <th scope="col">État</th>
                        <th scope="col">
                          <span className={styles.srOnly}>Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((invoice) => (
                        <tr key={invoice.id}>
                          <th scope="row">
                            <span className={styles.student}>{invoice.studentName}</span>
                            {invoice.studentEmail && (
                              <span className={styles.email}>{invoice.studentEmail}</span>
                            )}
                          </th>
                          <td>{invoice.dueDate ? formatDueDate(invoice.dueDate) : '—'}</td>
                          <td className={styles.money}>{formatMoney(invoiceTotal(invoice))}</td>
                          <td className={styles.money}>{formatMoney(invoiceBalance(invoice))}</td>
                          <td>
                            <StatusBadge invoice={invoice} now={now} />
                          </td>
                          <td className={styles.actions}>
                            {invoiceBalance(invoice) > 0 && (
                              <button
                                type="button"
                                className={`${styles.button} ${styles.small}`}
                                aria-label={`Marquer payée : ${invoice.studentName}`}
                                onClick={() => void markPaid(invoice)}
                              >
                                Marquer payée
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {creating && (
        <NewInvoicePopup
          session={session}
          now={now}
          onCreate={create}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}
