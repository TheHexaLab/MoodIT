import React from 'react';
import styles from './AssignmentView.module.css';
import { ChannelTypeIcon } from '../../CourseChannelList/ChannelTypeIcon.tsx';
import type { Assignment } from '../../../types/domain.ts';
import {
  type Badge,
  byDueDate,
  dueBadge,
  formatDateTime,
  submissionBadge,
} from './assignmentFormat.ts';

interface AssignmentListProps {
  assignments: Assignment[];
  now: Date;
  onOpen: (assignmentId: number) => void;
}

export function StatusPill({ badge }: { badge: Badge }): React.ReactElement {
  return <span className={`${styles.pill} ${styles[badge.tone]}`}>{badge.label}</span>;
}

/** Une ligne de devoir : toute la ligne ouvre le devoir. */
export function AssignmentRow({
  assignment,
  detail,
  meta,
  badge,
  onOpen,
}: {
  assignment: Assignment;
  detail: string;
  meta?: string;
  badge: Badge;
  onOpen: (assignmentId: number) => void;
}): React.ReactElement {
  return (
    <li>
      <button type="button" className={styles.row} onClick={() => onOpen(assignment.id)}>
        <span className={`${styles.tile} ${styles[badge.tone]}`}>
          <ChannelTypeIcon type="assignment" />
        </span>
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{assignment.title}</span>
          <span className={styles.rowDetail}>{detail}</span>
        </span>
        {meta && <span className={styles.rowMeta}>{meta}</span>}
        <StatusPill badge={badge} />
      </button>
    </li>
  );
}

/** Devoirs d'un cours pour l'étudiant : ce qui reste à remettre d'abord, puis ce qui est remis. */
export function AssignmentList({
  assignments,
  now,
  onOpen,
}: AssignmentListProps): React.ReactElement {
  const toSubmit = assignments.filter((a) => !a.submission).sort(byDueDate);
  const submitted = assignments.filter((a) => a.submission).sort((a, b) => byDueDate(b, a));
  const next = toSubmit[0];

  return (
    <div className={styles.columns}>
      <div className={styles.main}>
        <div>
          <h1 className={styles.title}>Devoirs</h1>
          <p className={styles.subtitle}>
            {toSubmit.length} à remettre, {submitted.length} remis
          </p>
        </div>

        {assignments.length === 0 && <p className={styles.empty}>Aucun devoir pour le moment.</p>}

        {toSubmit.length > 0 && (
          <section aria-label="À remettre" className={styles.group}>
            <h2 className={styles.groupTitle}>À remettre</h2>
            <ul className={styles.rows}>
              {toSubmit.map((assignment) => (
                <AssignmentRow
                  key={assignment.id}
                  assignment={assignment}
                  detail={
                    assignment.dueAt
                      ? `À remettre le ${formatDateTime(assignment.dueAt)}`
                      : 'Sans date limite'
                  }
                  meta={assignment.weight != null ? `${assignment.weight} %` : undefined}
                  badge={dueBadge(assignment, now)}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </section>
        )}

        {submitted.length > 0 && (
          <section aria-label="Remis" className={styles.group}>
            <h2 className={styles.groupTitle}>Remis</h2>
            <ul className={styles.rows}>
              {submitted.map((assignment) => {
                const submission = assignment.submission!;
                return (
                  <AssignmentRow
                    key={assignment.id}
                    assignment={assignment}
                    detail={`Remis le ${formatDateTime(submission.submittedAt)}${submission.late ? ', en retard' : ''}`}
                    meta={submission.grade ?? 'En correction'}
                    badge={submissionBadge(assignment)}
                    onOpen={onOpen}
                  />
                );
              })}
            </ul>
          </section>
        )}
      </div>

      {next && (
        <aside className={styles.side} aria-label="Résumé">
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Prochaine échéance</h2>
            <p className={styles.cardStrong}>{next.title}</p>
            {next.dueAt && <p className={styles.cardDue}>{formatDateTime(next.dueAt)}</p>}
            <button
              type="button"
              className={`${styles.button} ${styles.primary} ${styles.block}`}
              onClick={() => onOpen(next.id)}
            >
              Ouvrir le devoir
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
