import React, { useEffect, useRef, useState } from 'react';
import styles from './InvoicesAdminPage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import BillingOverview from './BillingOverview.tsx';
import FeeScheduleEditor from './FeeScheduleEditor.tsx';
import { StudentBillingPopup } from './StudentBillingPopup.tsx';
import type { EnrolledStudent, FeeSchedule } from '../../types/domain.ts';

/** Accès à la facturation : dashboardApi, données fictives en attendant une API. */
export interface InvoicesAdminApi {
  fetchSchedule: () => Promise<FeeSchedule>;
  saveSchedule: (schedule: FeeSchedule) => Promise<FeeSchedule>;
  fetchStudents: () => Promise<EnrolledStudent[]>;
}

interface InvoicesAdminPageProps {
  api: InvoicesAdminApi;
  /** Aujourd'hui : retards, échéance et date des paiements enregistrés. */
  now?: Date;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; schedule: FeeSchedule; students: EnrolledStudent[] };

type Tab = 'students' | 'pricing';

const TABS: { id: Tab; label: string }[] = [
  { id: 'students', label: 'Suivi des étudiants' },
  { id: 'pricing', label: 'Tarification' },
];

/**
 * Factures, vue de l'administration (#207). L'administration ne fait pas une facture par étudiant :
 * elle fixe la tarification de la session (prix du crédit selon le statut, frais), et la facture de
 * chaque étudiant en découle. Deux onglets : le suivi des paiements de tous les étudiants, et la
 * tarification.
 */
export default function InvoicesAdminPage({
  api,
  now = new Date(),
}: InvoicesAdminPageProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<Tab>('students');
  const [openStudentId, setOpenStudentId] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ students: null, pricing: null });

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.fetchSchedule(), api.fetchStudents()]).then(
      ([schedule, students]) => {
        if (!cancelled) setState({ status: 'ready', schedule, students });
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

  if (state.status !== 'ready') {
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
  const openStudent = students.find((student) => student.id === openStudentId);

  const saveSchedule = async (next: FeeSchedule) => {
    const saved = await api.saveSchedule(next);
    setState({ status: 'ready', schedule: saved, students });
    setNotice('Tarification enregistrée. Les factures des étudiants sont à jour.');
  };

  // Onglets au clavier : flèches gauche et droite, Début et Fin.
  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    const last = TABS.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  };

  return (
    <section className={styles.page} aria-label="Contenu principal">
      <div className={styles.main}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Factures</h1>
            <p className={styles.subtitle}>Facturation de la session d'{schedule.session}</p>
          </div>
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Facturation">
          {TABS.map(({ id, label }, index) => (
            <button
              key={id}
              ref={(element) => {
                tabRefs.current[id] = element;
              }}
              type="button"
              role="tab"
              id={`billing-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`billing-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={`${styles.tab} ${tab === id ? styles.tabOn : ''}`}
              onClick={() => setTab(id)}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Annonce des actions (tarification enregistrée) aux lecteurs d'écran. */}
        <p className={styles.notice} role="status">
          {notice}
        </p>

        <div
          role="tabpanel"
          id={`billing-panel-${tab}`}
          aria-labelledby={`billing-tab-${tab}`}
          className={styles.panel}
        >
          {tab === 'students' ? (
            <BillingOverview
              schedule={schedule}
              students={students}
              now={now}
              onOpenStudent={(id) => {
                setNotice('');
                setOpenStudentId(id);
              }}
            />
          ) : (
            <FeeScheduleEditor
              schedule={schedule}
              studentCounts={Object.fromEntries(
                schedule.statuses.map((status) => [
                  status.id,
                  students.filter((student) => student.residency === status.id).length,
                ])
              )}
              onSave={saveSchedule}
            />
          )}
        </div>
      </div>

      {openStudent && (
        <StudentBillingPopup
          student={openStudent}
          schedule={schedule}
          now={now}
          onClose={() => setOpenStudentId(null)}
        />
      )}
    </section>
  );
}
