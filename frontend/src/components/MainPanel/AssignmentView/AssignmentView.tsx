import React, { useEffect, useState } from 'react';
import styles from './AssignmentView.module.css';
import { AssignmentDetail, BackLink } from './AssignmentDetail.tsx';
import { AssignmentList } from './AssignmentList.tsx';
import { ChannelTypeIcon } from '../../CourseChannelList/ChannelTypeIcon.tsx';
import { getCourseDisplayLabel } from '../../CourseMenu/courseLabel';
import { Spinner } from '../../Spinner/Spinner.tsx';
import type { Assignment, Course } from '../../../types/domain.ts';

/** Id de canal de la liste des devoirs (`/assignment/0`) ; un autre id ouvre ce devoir. */
export const ASSIGNMENT_LIST_ID = 0;

/** Accès aux devoirs (dashboardApi : données fictives pour l'instant, #252). */
export interface AssignmentHandlers {
  onFetchAssignments: (courseId: number, includeDrafts?: boolean) => Promise<Assignment[]>;
  onSubmitAssignment: (
    courseId: number,
    assignmentId: number,
    fileName: string
  ) => Promise<Assignment>;
  /** La liste a changé (ex. une remise) : le parent met à jour le compte du panneau. */
  onAssignmentsChanged?: () => void;
}

interface AssignmentViewProps {
  course: Course;
  /** {@link ASSIGNMENT_LIST_ID} : la liste ; sinon, le devoir ouvert. */
  assignmentId: number;
  handlers: AssignmentHandlers;
  /** Ouvre un devoir, ou revient à la liste. L'URL porte la vue (#63). */
  onOpen: (assignmentId: number) => void;
  /** Date de référence (injectée par les tests). */
  now?: Date;
}

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; assignments: Assignment[] };

/** Canal Devoirs d'un cours. */
export default function AssignmentView({
  course,
  assignmentId,
  handlers,
  onOpen,
  now = new Date(),
}: AssignmentViewProps): React.ReactElement {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** Incrémenté par « Réessayer » : relance le chargement. */
  const [attempt, setAttempt] = useState(0);
  const { onFetchAssignments } = handlers;

  useEffect(() => {
    let cancelled = false;
    onFetchAssignments(course.id)
      .then((assignments) => {
        if (!cancelled) setLoad({ status: 'ready', assignments: [...assignments] });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [course.id, onFetchAssignments, attempt]);

  const assignments = load.status === 'ready' ? load.assignments : [];
  const opened =
    assignmentId === ASSIGNMENT_LIST_ID
      ? undefined
      : assignments.find((assignment) => assignment.id === assignmentId);

  async function submit(fileName: string) {
    const updated = await handlers.onSubmitAssignment(course.id, assignmentId, fileName);
    setLoad({
      status: 'ready',
      assignments: assignments.map((a) => (a.id === updated.id ? { ...updated } : a)),
    });
    handlers.onAssignmentsChanged?.();
  }

  function renderContent(): React.ReactNode {
    if (load.status === 'loading') {
      return (
        <div className={styles.state} role="status" aria-busy="true">
          <Spinner size={24} />
          <p>Chargement des devoirs…</p>
        </div>
      );
    }
    if (load.status === 'error') {
      return (
        <div className={styles.state} role="alert">
          <p>Impossible de charger les devoirs.</p>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((previous) => previous + 1);
            }}
          >
            Réessayer
          </button>
        </div>
      );
    }
    if (assignmentId === ASSIGNMENT_LIST_ID) {
      return <AssignmentList assignments={assignments} now={now} onOpen={onOpen} />;
    }
    if (!opened) {
      return (
        <div className={styles.main}>
          <BackLink onBack={() => onOpen(ASSIGNMENT_LIST_ID)} />
          <p className={styles.empty}>Ce devoir n'existe plus.</p>
        </div>
      );
    }
    return (
      <AssignmentDetail
        assignment={opened}
        now={now}
        onBack={() => onOpen(ASSIGNMENT_LIST_ID)}
        onSubmit={submit}
      />
    );
  }

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <p className={styles.headerTitle}>
          <span className={styles.headerIcon}>
            <ChannelTypeIcon type="assignment" />
          </span>
          Devoirs
        </p>
        <span className={styles.headerDivider} />
        <p className={styles.headerCourse}>
          {opened ? `${opened.title} · ` : ''}
          {getCourseDisplayLabel(course)}
        </p>
      </header>
      <div className={styles.content}>{renderContent()}</div>
    </div>
  );
}
