import React, { useEffect, useState } from 'react';
import styles from './InvoicesAdminPage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import type { EnrolledStudent, FeeSchedule, InvoicePayment } from '../../types/domain.ts';
import {
  formatMoney,
  invoiceBalance,
  invoiceFromSchedule,
  invoicePaid,
  invoiceStatus,
  invoiceTotal,
  isoDay,
  parseAmount,
  sharedFeesCents,
  tuitionCents,
} from '../InvoicesPage/invoice.ts';

/** Accès à la facturation : dashboardApi, données fictives en attendant une API. */
export interface InvoicesAdminApi {
  fetchSchedule: () => Promise<FeeSchedule>;
  saveSchedule: (schedule: FeeSchedule) => Promise<FeeSchedule>;
  fetchStudents: () => Promise<EnrolledStudent[]>;
  recordPayment: (studentId: number, payment: InvoicePayment) => Promise<EnrolledStudent>;
}

interface InvoicesAdminPageProps {
  api: InvoicesAdminApi;
  /** Aujourd'hui : retards et date des paiements enregistrés. */
  now?: Date;
}

/** Frais commun en cours de saisie : les montants restent du texte jusqu'à l'enregistrement. */
interface FeeInput {
  key: number;
  label: string;
  detail: string;
  amount: string;
}

interface Draft {
  creditPrice: string;
  dueDate: string;
  fees: FeeInput[];
}

/** Libellés de frais courants, ajoutés d'un clic. */
const COMMON_FEES = [
  'Frais afférents',
  'Assurance collective',
  'Frais technologiques',
  'Association étudiante',
];

/** Nombre de crédits de l'exemple : une session à temps plein. */
const EXAMPLE_CREDITS = '15';

/** 13450 → « 134,50 » : un montant tel qu'on le tape. */
function amountText(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function toDraft(schedule: FeeSchedule): Draft {
  return {
    creditPrice: amountText(schedule.creditPriceCents),
    dueDate: schedule.dueDate,
    fees: schedule.fees.map((fee, index) => ({
      key: index + 1,
      label: fee.label,
      detail: fee.detail ?? '',
      amount: amountText(fee.amountCents),
    })),
  };
}

/** Montant saisi, ou 0 s'il est illisible : pour le calcul en direct seulement. */
const centsOrZero = (text: string) => {
  const cents = parseAmount(text);
  return Number.isNaN(cents) ? 0 : cents;
};

/** Pastille d'état de la facture d'un étudiant. */
function StatusBadge({
  status,
  partial,
}: {
  status: string;
  partial: boolean;
}): React.ReactElement {
  if (status === 'paid')
    return <span className={`${styles.badge} ${styles.badgePaid}`}>Payée</span>;
  if (status === 'late')
    return <span className={`${styles.badge} ${styles.badgeLate}`}>En retard</span>;
  if (partial)
    return <span className={`${styles.badge} ${styles.badgePartial}`}>Paiement partiel</span>;
  return <span className={`${styles.badge} ${styles.badgeDue}`}>À payer</span>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; schedule: FeeSchedule; students: EnrolledStudent[] };

/**
 * Factures, vue de l'administration (#207). L'administration ne fait pas une facture par étudiant :
 * elle fixe la tarification de la session (prix du crédit et frais communs), et la facture de
 * chaque étudiant en découle : crédits × prix du crédit + frais communs.
 */
export default function InvoicesAdminPage({
  api,
  now = new Date(),
}: InvoicesAdminPageProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [nextKey, setNextKey] = useState(100);
  const [dirty, setDirty] = useState(false);
  const [exampleCredits, setExampleCredits] = useState(EXAMPLE_CREDITS);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.fetchSchedule(), api.fetchStudents()]).then(
      ([schedule, students]) => {
        if (cancelled) return;
        setState({ status: 'ready', schedule, students });
        setDraft(toDraft(schedule));
      },
      () => {
        if (!cancelled) setState({ status: 'error' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  };

  const change = (next: Draft) => {
    setDraft(next);
    setDirty(true);
    setNotice('');
  };

  if (state.status !== 'ready' || !draft) {
    return (
      <section className={styles.page} aria-label="Contenu principal">
        <div className={styles.main}>
          <h1 className={styles.title}>Factures</h1>
          {state.status === 'error' ? (
            <div className={`${styles.card} ${styles.state}`} role="alert">
              <span>Impossible de charger la facturation.</span>
              <button type="button" className={styles.button} onClick={retry}>
                Réessayer
              </button>
            </div>
          ) : (
            <div className={`${styles.card} ${styles.state}`} role="status" aria-busy="true">
              <Spinner size={24} />
              <span>Chargement de la facturation…</span>
            </div>
          )}
        </div>
      </section>
    );
  }

  const { schedule, students } = state;

  // Calcul en direct, avec ce qui est saisi (même pas encore enregistré).
  const priceCents = centsOrZero(draft.creditPrice);
  const feesCents = draft.fees.reduce((sum, fee) => sum + centsOrZero(fee.amount), 0);
  const credits = Math.max(0, Math.floor(Number(exampleCredits) || 0));
  const exampleTotal = tuitionCents(credits, priceCents) + feesCents;

  const updateFee = (key: number, patch: Partial<FeeInput>) =>
    change({
      ...draft,
      fees: draft.fees.map((fee) => (fee.key === key ? { ...fee, ...patch } : fee)),
    });

  const addFee = (label = '') => {
    change({ ...draft, fees: [...draft.fees, { key: nextKey, label, detail: '', amount: '' }] });
    setNextKey(nextKey + 1);
  };

  async function save() {
    if (!draft) return;
    const price = parseAmount(draft.creditPrice);
    if (!(price > 0)) return setError('Indiquez un prix du crédit plus grand que 0.');
    if (!draft.dueDate) return setError("Indiquez l'échéance.");
    const fees = draft.fees.map((fee) => ({
      label: fee.label.trim(),
      detail: fee.detail.trim() || undefined,
      amountCents: parseAmount(fee.amount),
    }));
    if (fees.some((fee) => !fee.label || !(fee.amountCents > 0))) {
      return setError("Chaque frais a besoin d'un libellé et d'un montant plus grand que 0.");
    }
    setError(null);
    setSaving(true);
    try {
      const saved = await api.saveSchedule({
        session: schedule.session,
        creditPriceCents: price,
        dueDate: draft.dueDate,
        fees,
      });
      setState({ status: 'ready', schedule: saved, students });
      setDraft(toDraft(saved));
      setDirty(false);
      setNotice('Tarification enregistrée. Les factures des étudiants sont à jour.');
    } catch {
      setError("La tarification n'a pas pu être enregistrée. Réessayez.");
    } finally {
      setSaving(false);
    }
  }

  const cancel = () => {
    setDraft(toDraft(schedule));
    setDirty(false);
    setError(null);
  };

  const markPaid = async (student: EnrolledStudent) => {
    const balance = invoiceBalance(
      invoiceFromSchedule(schedule, student.credits, student.payments)
    );
    try {
      const updated = await api.recordPayment(student.id, {
        date: isoDay(now),
        amountCents: balance,
        method: "Enregistré par l'administration",
      });
      setState({
        status: 'ready',
        schedule,
        students: students.map((other) => (other.id === updated.id ? updated : other)),
      });
      setNotice(`Paiement enregistré pour ${student.name}.`);
    } catch {
      setNotice("Le paiement n'a pas pu être enregistré. Réessayez.");
    }
  };

  // Factures des étudiants, selon la tarification ENREGISTRÉE.
  const rows = students.map((student) => ({
    student,
    invoice: invoiceFromSchedule(schedule, student.credits, student.payments),
  }));
  const billed = rows.reduce((sum, row) => sum + invoiceTotal(row.invoice), 0);
  const received = rows.reduce((sum, row) => sum + invoicePaid(row.invoice), 0);
  const outstanding = rows.reduce((sum, row) => sum + invoiceBalance(row.invoice), 0);
  const lateCount = rows.filter((row) => invoiceStatus(row.invoice, now) === 'late').length;
  const savedFees = sharedFeesCents(schedule);

  return (
    <section className={styles.page} aria-label="Contenu principal">
      <div className={styles.main}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Factures</h1>
            <p className={styles.subtitle}>Tarification de la session d'{schedule.session}</p>
          </div>
          <div className={styles.headerActions}>
            {dirty && (
              <button type="button" className={styles.button} onClick={cancel}>
                Annuler les changements
              </button>
            )}
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              Enregistrer
            </button>
          </div>
        </div>

        {/* Annonce des actions (tarification enregistrée, paiement) aux lecteurs d'écran. */}
        <p className={styles.notice} role="status">
          {notice}
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {/* L'équation : crédits × prix du crédit + frais communs = facture. */}
        <div className={`${styles.card} ${styles.formulaCard}`}>
          <h2 className={styles.cardTitle}>Calcul de la facture</h2>
          <p className={styles.cardHint}>
            Chaque étudiant paie ses crédits au prix du crédit, plus les mêmes frais communs.
          </p>
          <div className={styles.formula}>
            <label className={styles.term}>
              <span className={styles.termLabel}>Crédits de l'étudiant</span>
              <input
                className={styles.termInput}
                type="number"
                min={0}
                max={30}
                value={exampleCredits}
                onChange={(event) => setExampleCredits(event.target.value)}
              />
              <span className={styles.termNote}>Exemple, à essayer</span>
            </label>
            <span className={styles.operator} aria-hidden="true">
              ×
            </span>
            <label className={styles.term}>
              <span className={styles.termLabel}>Prix du crédit</span>
              <span className={styles.money}>
                <input
                  className={styles.termInput}
                  type="text"
                  inputMode="decimal"
                  value={draft.creditPrice}
                  onChange={(event) => change({ ...draft, creditPrice: event.target.value })}
                />
                <span aria-hidden="true">$</span>
              </span>
              <span className={styles.termNote}>
                = {formatMoney(tuitionCents(credits, priceCents))} de droits
              </span>
            </label>
            <span className={styles.operator} aria-hidden="true">
              +
            </span>
            <div className={styles.term}>
              <span className={styles.termLabel}>Frais communs</span>
              <span className={styles.termValue}>{formatMoney(feesCents)}</span>
              <span className={styles.termNote}>{draft.fees.length} frais, voir ci-dessous</span>
            </div>
            <span className={styles.operator} aria-hidden="true">
              =
            </span>
            <div className={`${styles.term} ${styles.result}`}>
              <span className={styles.termLabel}>Facture de l'étudiant</span>
              <span className={styles.termValue} aria-live="polite">
                {formatMoney(exampleTotal)}
              </span>
              <span className={styles.termNote}>
                Pour {credits} {credits > 1 ? 'crédits' : 'crédit'}
              </span>
            </div>
          </div>
          <label className={styles.dueField}>
            <span>Échéance de paiement</span>
            <input
              type="date"
              value={draft.dueDate}
              onChange={(event) => change({ ...draft, dueDate: event.target.value })}
            />
          </label>
        </div>

        {/* Frais communs : la liste que l'administration compose. */}
        <fieldset className={`${styles.card} ${styles.feesCard}`}>
          <legend className={styles.cardTitle}>Frais communs</legend>
          <p className={styles.cardHint}>
            Payés par tous les étudiants, quel que soit leur nombre de crédits.
          </p>
          {draft.fees.length === 0 ? (
            <p className={styles.emptyFees}>
              Aucun frais commun : la facture se limite aux crédits.
            </p>
          ) : (
            <ul className={styles.fees}>
              {draft.fees.map((fee, index) => (
                <li key={fee.key} className={styles.fee}>
                  <label className={styles.field}>
                    <span>Libellé</span>
                    <input
                      type="text"
                      value={fee.label}
                      maxLength={80}
                      placeholder="Frais afférents"
                      onChange={(event) => updateFee(fee.key, { label: event.target.value })}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>Précision (facultatif)</span>
                    <input
                      type="text"
                      value={fee.detail}
                      maxLength={80}

                      onChange={(event) => updateFee(fee.key, { detail: event.target.value })}
                    />
                  </label>
                  <label className={`${styles.field} ${styles.amountField}`}>
                    <span>Montant ($)</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={fee.amount}
                      placeholder="0,00"
                      onChange={(event) => updateFee(fee.key, { amount: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Retirer le frais ${index + 1}${fee.label.trim() ? ` : ${fee.label.trim()}` : ''}`}
                    onClick={() =>
                      change({
                        ...draft,
                        fees: draft.fees.filter((other) => other.key !== fee.key),
                      })
                    }
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.chips}>
            <button type="button" className={styles.chip} onClick={() => addFee()}>
              + Ajouter un frais
            </button>
            {COMMON_FEES.filter(
              (label) => !draft.fees.some((fee) => fee.label.trim() === label)
            ).map((label) => (
              <button
                key={label}
                type="button"
                className={styles.chip}
                onClick={() => addFee(label)}
              >
                + {label}
              </button>
            ))}
          </div>
          <p className={styles.feesTotal}>
            <span>Total des frais communs, par étudiant</span>
            <strong>{formatMoney(feesCents)}</strong>
          </p>
        </fieldset>

        <h2 className={styles.sectionTitle}>Étudiants inscrits</h2>
        {dirty && (
          <p className={styles.cardHint}>
            Le tableau suit la tarification enregistrée. Enregistrez pour appliquer vos changements.
          </p>
        )}

        <dl className={styles.stats}>
          <div className={styles.card}>
            <dt>Facturé</dt>
            <dd>
              <span className={styles.statValue}>{formatMoney(billed)}</span>
              <span className={styles.statNote}>
                {students.length} {students.length > 1 ? 'étudiants' : 'étudiant'}
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
          {rows.length === 0 ? (
            <p className={styles.empty}>Aucun étudiant inscrit pour cette session.</p>
          ) : (
            <div className={styles.scroll}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Factures des étudiants inscrits</caption>
                <thead>
                  <tr>
                    <th scope="col">Étudiant</th>
                    <th scope="col">Crédits</th>
                    <th scope="col">Droits</th>
                    <th scope="col">Frais communs</th>
                    <th scope="col">Total</th>
                    <th scope="col">Solde</th>
                    <th scope="col">État</th>
                    <th scope="col">
                      <span className={styles.srOnly}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ student, invoice }) => (
                    <tr key={student.id}>
                      <th scope="row">
                        <span className={styles.student}>{student.name}</span>
                        {student.email && <span className={styles.email}>{student.email}</span>}
                      </th>
                      <td className={styles.number}>{student.credits}</td>
                      <td className={styles.number}>
                        {formatMoney(tuitionCents(student.credits, schedule.creditPriceCents))}
                      </td>
                      <td className={styles.number}>{formatMoney(savedFees)}</td>
                      <td className={styles.number}>{formatMoney(invoiceTotal(invoice))}</td>
                      <td className={styles.number}>{formatMoney(invoiceBalance(invoice))}</td>
                      <td>
                        <StatusBadge
                          status={invoiceStatus(invoice, now)}
                          partial={invoicePaid(invoice) > 0}
                        />
                      </td>
                      <td className={styles.actions}>
                        {invoiceBalance(invoice) > 0 && (
                          <button
                            type="button"
                            className={`${styles.button} ${styles.small}`}
                            aria-label={`Marquer payée : ${student.name}`}
                            onClick={() => void markPaid(student)}
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
      </div>
    </section>
  );
}
