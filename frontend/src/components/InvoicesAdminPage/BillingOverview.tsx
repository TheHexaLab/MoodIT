import React, { useState } from 'react';
import styles from './InvoicesAdminPage.module.css';
import type { EnrolledStudent, FeeSchedule } from '../../types/domain.ts';
import {
  daysUntil,
  formatDueDate,
  formatMoney,
  invoiceInterest,
  statusLabel,
} from '../InvoicesPage/invoice.ts';
import {
  billingCsv,
  billingRow,
  normalizeSearch,
  PAYMENT_LABELS,
  PAYMENT_STATES,
  stateRank,
  type BillingRow,
  type PaymentState,
} from './billing.ts';
import { STATE_BADGE } from './stateBadge.ts';

type SortKey = 'name' | 'balance' | 'state' | 'credits';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'state', label: 'État de paiement' },
  { key: 'balance', label: 'Solde le plus élevé' },
  { key: 'name', label: 'Nom (A à Z)' },
  { key: 'credits', label: 'Crédits' },
];

const compare: Record<SortKey, (a: BillingRow, b: BillingRow) => number> = {
  name: (a, b) => a.student.name.localeCompare(b.student.name, 'fr'),
  balance: (a, b) => b.balance - a.balance,
  credits: (a, b) => b.student.credits - a.student.credits,
  state: (a, b) => stateRank(a.state) - stateRank(b.state) || b.balance - a.balance,
};

interface BillingOverviewProps {
  schedule: FeeSchedule;
  students: EnrolledStudent[];
  now: Date;
  /** Ouvre le détail d'un étudiant. */
  onOpenStudent: (studentId: number) => void;
}

/** Télécharge le suivi affiché, au format CSV. */
function downloadCsv(rows: BillingRow[], schedule: FeeSchedule): void {
  const blob = new Blob([billingCsv(rows, schedule)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `facturation-${schedule.session.replace(/\s+/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Suivi de la facturation : où en sont les paiements de la session, puis chaque étudiant, avec
 * recherche, filtres par état et par statut, tri et export.
 */
export default function BillingOverview({
  schedule,
  students,
  now,
  onOpenStudent,
}: BillingOverviewProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<PaymentState | 'all'>('all');
  const [residency, setResidency] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('state');

  const rows = students.map((student) => billingRow(schedule, student, now));
  const billed = rows.reduce((sum, row) => sum + row.total, 0);
  const received = rows.reduce((sum, row) => sum + row.paid, 0);
  const outstanding = rows.reduce((sum, row) => sum + row.balance, 0);
  const openCount = rows.filter((row) => row.balance > 0).length;
  // Intérêts de retard déjà courus, compris dans « À recevoir ».
  const interest = rows.reduce((sum, row) => sum + invoiceInterest(row.invoice), 0);
  const lateCount = rows.filter((row) => row.state === 'late').length;
  const collected = billed > 0 ? Math.round((received / billed) * 100) : 0;
  const days = daysUntil(schedule.dueDate, now);
  const counts = Object.fromEntries(
    PAYMENT_STATES.map(({ state }) => [state, rows.filter((row) => row.state === state).length])
  ) as Record<PaymentState, number>;

  const search = normalizeSearch(query);
  const shown = rows
    .filter((row) => stateFilter === 'all' || row.state === stateFilter)
    .filter((row) => residency === 'all' || row.student.residency === residency)
    .filter(
      (row) =>
        !search ||
        [row.student.name, row.student.email, row.student.studentNumber, row.student.program]
          .filter(Boolean)
          .some((field) => normalizeSearch(field!).includes(search))
    )
    .sort(compare[sort]);
  const shownBalance = shown.reduce((sum, row) => sum + row.balance, 0);
  const filtered = stateFilter !== 'all' || residency !== 'all' || search !== '';

  return (
    <div className={styles.overview}>
      <dl className={styles.kpis}>
        <div className={styles.kpi}>
          <dt>Facturé</dt>
          <dd>
            <span className={styles.kpiValue}>{formatMoney(billed)}</span>
            <span className={styles.kpiNote}>
              {students.length} {students.length > 1 ? 'étudiants inscrits' : 'étudiant inscrit'}
            </span>
          </dd>
        </div>
        <div className={styles.kpi}>
          <dt>Encaissé</dt>
          <dd>
            <span className={styles.kpiValue}>{formatMoney(received)}</span>
            <span
              className={styles.meter}
              role="meter"
              aria-label="Part encaissée"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={collected}
            >
              <span style={{ width: `${collected}%` }} />
            </span>
            <span className={styles.kpiNote}>{collected} % du total</span>
          </dd>
        </div>
        <div className={styles.kpi}>
          <dt>À recevoir</dt>
          <dd>
            <span className={styles.kpiValue}>{formatMoney(outstanding)}</span>
            <span className={styles.kpiNote}>
              {openCount} {openCount > 1 ? 'soldes ouverts' : 'solde ouvert'}
              {interest > 0 && `, dont ${formatMoney(interest)} d'intérêts`}
            </span>
          </dd>
        </div>
        <div className={`${styles.kpi} ${lateCount > 0 ? styles.kpiAlert : ''}`}>
          <dt>Échéance</dt>
          <dd>
            <span className={styles.kpiValue}>{formatDueDate(schedule.dueDate)}</span>
            <span className={styles.kpiNote}>
              {lateCount > 0
                ? `${lateCount} en retard`
                : days > 1
                  ? `Dans ${days} jours`
                  : days === 1
                    ? 'Demain'
                    : days === 0
                      ? "Aujourd'hui"
                      : 'Passée'}
            </span>
          </dd>
        </div>
      </dl>

      {/* La liste, dans une seule carte : en tête, la recherche (statut, tri, export) puis la
          répartition par état, dont la légende sert de filtre ; ensuite le tableau. */}
      <div className={`${styles.card} ${styles.tableCard}`}>
        <div className={styles.listHeader}>
          <div className={styles.toolbar}>
            <label className={styles.search}>
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                <path
                  d="m20 20-3.5-3.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <input
                type="search"
                value={query}
                placeholder="Nom, matricule, courriel ou programme"
                aria-label="Rechercher un étudiant"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className={styles.select}>
              <span>Statut</span>
              <select value={residency} onChange={(event) => setResidency(event.target.value)}>
                <option value="all">Tous</option>
                {schedule.statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.select}>
              <span>Trier par</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                {SORTS.map(({ key, label }) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.button}
              disabled={shown.length === 0}
              onClick={() => downloadCsv(shown, schedule)}
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
              Exporter (CSV)
            </button>
          </div>

          <div className={styles.breakdown}>
            <div className={styles.stack} aria-hidden="true">
              {PAYMENT_STATES.filter(({ state }) => counts[state] > 0).map(({ state }) => (
                <span
                  key={state}
                  className={`${styles.stackPart} ${STATE_BADGE[state]}`}
                  style={{ flexGrow: counts[state] }}
                />
              ))}
            </div>
            <div className={styles.filters} role="group" aria-label="Filtrer par état">
              <button
                type="button"
                className={`${styles.filter} ${stateFilter === 'all' ? styles.filterOn : ''}`}
                aria-pressed={stateFilter === 'all'}
                onClick={() => setStateFilter('all')}
              >
                Tous <span className={styles.count}>{rows.length}</span>
              </button>
              {PAYMENT_STATES.map(({ state, label }) => (
                <button
                  key={state}
                  type="button"
                  className={`${styles.filter} ${stateFilter === state ? styles.filterOn : ''}`}
                  aria-pressed={stateFilter === state}
                  onClick={() => setStateFilter(state)}
                >
                  <span className={`${styles.dot} ${STATE_BADGE[state]}`} aria-hidden="true" />
                  {label} <span className={styles.count}>{counts[state]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {shown.length === 0 ? (
          <div className={styles.empty}>
            <p>
              {students.length === 0
                ? 'Aucun étudiant inscrit pour cette session.'
                : 'Aucun étudiant ne correspond à ces filtres.'}
            </p>
            {filtered && students.length > 0 && (
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  setQuery('');
                  setStateFilter('all');
                  setResidency('all');
                }}
              >
                Effacer les filtres
              </button>
            )}
          </div>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>Facturation des étudiants inscrits</caption>
              <thead>
                <tr>
                  <th scope="col">Étudiant</th>
                  <th scope="col">Statut</th>
                  <th scope="col" className={styles.number}>
                    Crédits
                  </th>
                  <th scope="col" className={styles.number}>
                    Total
                  </th>
                  <th scope="col" className={styles.number}>
                    Payé
                  </th>
                  <th scope="col" className={styles.number}>
                    Solde
                  </th>
                  <th scope="col">État</th>
                  <th scope="col">
                    <span className={styles.srOnly}>Détail</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  // Toute la ligne ouvre le détail ; au clavier, le nom est un bouton.
                  <tr
                    key={row.student.id}
                    className={styles.clickable}
                    onClick={() => onOpenStudent(row.student.id)}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className={styles.studentButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenStudent(row.student.id);
                        }}
                      >
                        {row.student.name}
                      </button>
                      <span className={styles.studentMeta}>
                        {[row.student.studentNumber, row.student.program]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </th>
                    <td>
                      <span className={styles.residency}>
                        {statusLabel(schedule, row.student.residency)}
                      </span>
                    </td>
                    <td className={styles.number}>{row.student.credits}</td>
                    <td className={styles.number}>{formatMoney(row.total)}</td>
                    <td className={styles.number}>{formatMoney(row.paid)}</td>
                    <td className={`${styles.number} ${row.balance > 0 ? styles.strong : ''}`}>
                      {formatMoney(row.balance)}
                    </td>
                    <td>
                      <span className={`${styles.badge} ${STATE_BADGE[row.state]}`}>
                        {PAYMENT_LABELS[row.state]}
                      </span>
                    </td>
                    <td className={styles.chevron} aria-hidden="true">
                      ›
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {shown.length > 0 && (
          <p className={styles.tableFooter}>
            <span>
              {shown.length === rows.length
                ? `${rows.length} ${rows.length > 1 ? 'étudiants' : 'étudiant'}`
                : `${shown.length} sur ${rows.length} étudiants`}
            </span>
            <span>
              Solde affiché : <strong>{formatMoney(shownBalance)}</strong>
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
