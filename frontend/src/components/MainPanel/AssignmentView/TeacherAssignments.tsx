import React, { useEffect, useState } from 'react';
import styles from './AssignmentView.module.css';
import { BackLink } from './AssignmentDetail.tsx';
import { AssignmentRow, StatusPill } from './AssignmentList.tsx';
import { Plus } from '../../../assets/Plus.tsx';
import { Spinner } from '../../Spinner/Spinner.tsx';
import type { Assignment, AssignmentStudentRow } from '../../../types/domain.ts';
import { type Badge, formatDateTime } from './assignmentFormat.ts';

/** Statut d'un devoir pour le prof. */
function teacherBadge(assignment: Assignment, now: Date): Badge {
  if (!assignment.isPublished) return { label: 'Brouillon', tone: 'neutral' };
  if (!assignment.dueAt || new Date(assignment.dueAt) >= now) {
    return { label: 'Publié', tone: 'info' };
  }
  return assignment.gradedCount >= assignment.submittedCount
    ? { label: 'Corrigé', tone: 'success' }
    : { label: 'En correction', tone: 'warn' };
}

function rowDetail(assignment: Assignment, now: Date): string {
  if (!assignment.dueAt) return 'Brouillon, date limite à définir';
  const due = formatDateTime(assignment.dueAt);
  if (!assignment.isPublished) return `Brouillon, date limite le ${due}`;
  return new Date(assignment.dueAt) >= now ? `À remettre le ${due}` : `Terminé le ${due}`;
}

/** Devoirs d'un cours pour le prof : brouillons compris, du plus récent au plus ancien. */
export function TeacherAssignmentList({
  assignments,
  now,
  onOpen,
  onNew,
  onEditDraft,
}: {
  assignments: Assignment[];
  now: Date;
  onOpen: (assignmentId: number) => void;
  onNew: () => void;
  onEditDraft: (assignment: Assignment) => void;
}): React.ReactElement {
  const drafts = assignments.filter((a) => !a.isPublished).length;
  const published = assignments.length - drafts;
  const sorted = [...assignments].sort((a, b) => b.id - a.id);

  return (
    <div className={styles.main}>
      <div className={styles.titleRow}>
        <div className={styles.titleText}>
          <h1 className={styles.title}>Devoirs</h1>
          <p className={styles.subtitle}>
            {published} {published > 1 ? 'publiés' : 'publié'}, {drafts}{' '}
            {drafts > 1 ? 'brouillons' : 'brouillon'}
          </p>
        </div>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onNew}>
          <Plus width={14} height={14} />
          Nouveau devoir
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className={styles.empty}>Aucun devoir pour le moment.</p>
      ) : (
        <ul className={styles.rows}>
          {sorted.map((assignment) => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              detail={rowDetail(assignment, now)}
              meta={
                assignment.isPublished
                  ? `${assignment.submittedCount} / ${assignment.studentCount} remis`
                  : undefined
              }
              badge={teacherBadge(assignment, now)}
              muted={!assignment.isPublished}
              onOpen={assignment.isPublished ? onOpen : () => onEditDraft(assignment)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const ROW_BADGE: Record<AssignmentStudentRow['status'], Badge> = {
  graded: { label: 'Corrigé', tone: 'success' },
  submitted: { label: 'Remis', tone: 'neutral' },
  late: { label: 'En retard', tone: 'danger' },
  missing: { label: 'Manquant', tone: 'warn' },
};

/** Suivi des remises d'un devoir : les chiffres, puis une ligne par étudiant. */
export function SubmissionTracking({
  assignment,
  onBack,
  onEdit,
  onFetchSubmissions,
}: {
  assignment: Assignment;
  onBack: () => void;
  onEdit: () => void;
  onFetchSubmissions: (assignment: Assignment) => Promise<AssignmentStudentRow[]>;
}): React.ReactElement {
  const [rows, setRows] = useState<AssignmentStudentRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    onFetchSubmissions(assignment)
      .then((loaded) => {
        if (!cancelled) setRows(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [assignment, onFetchSubmissions]);

  const count = (status: AssignmentStudentRow['status']) =>
    (rows ?? []).filter((row) => row.status === status).length;
  const submitted = (rows ?? []).length - count('missing');

  const stats = [
    { label: 'Remis', value: `${submitted} / ${rows?.length ?? 0}`, tone: '' },
    { label: 'En retard', value: String(count('late')), tone: styles.statDanger },
    { label: 'Manquants', value: String(count('missing')), tone: styles.statWarn },
    { label: 'Corrigés', value: `${count('graded')} / ${submitted}`, tone: styles.statSuccess },
  ];

  return (
    <div className={styles.main}>
      <BackLink onBack={onBack} />
      <div className={styles.titleRow}>
        <div className={styles.titleText}>
          <h1 className={styles.title}>{assignment.title}</h1>
          <p className={styles.subtitle}>
            {assignment.dueAt
              ? `Date limite : ${formatDateTime(assignment.dueAt)}`
              : 'Sans date limite'}
            {assignment.weight != null && ` · ${assignment.weight} % de la note`}
          </p>
        </div>
        <button type="button" className={styles.button} onClick={onEdit}>
          Modifier le devoir
        </button>
        {/* Saisie des notes à venir : présent pour la maquette, sans action pour l'instant. */}
        <button
          type="button"
          className={`${styles.button} ${styles.primary} ${styles.soon}`}
          aria-disabled="true"
          title="Bientôt disponible"
        >
          Publier les notes
        </button>
      </div>

      {failed ? (
        <p className={styles.empty} role="alert">
          Impossible de charger les remises.
        </p>
      ) : !rows ? (
        <div className={styles.state} role="status" aria-busy="true">
          <Spinner size={24} />
          <p>Chargement des remises…</p>
        </div>
      ) : (
        <>
          <dl className={styles.stats}>
            {stats.map((stat) => (
              <div key={stat.label} className={styles.stat}>
                <dd className={`${styles.statValue} ${stat.tone}`}>{stat.value}</dd>
                <dt>{stat.label}</dt>
              </div>
            ))}
          </dl>

          <div
            className={styles.tableWrap}
            role="region"
            aria-label="Remises des étudiants"
            tabIndex={0}
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Étudiant</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Remis le</th>
                  <th scope="col">Fichier</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.studentName}>
                    <th scope="row">{row.studentName}</th>
                    <td>
                      <StatusPill badge={ROW_BADGE[row.status]} />
                    </td>
                    <td>{row.submittedAt ? formatDateTime(row.submittedAt) : '—'}</td>
                    <td>{row.fileName ?? '—'}</td>
                    <td>
                      {row.grade ?? (row.status === 'missing' ? '—' : <em>À noter</em>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

