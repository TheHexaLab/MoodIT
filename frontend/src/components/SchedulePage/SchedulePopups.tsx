import React, { useState } from 'react';
import styles from './SchedulePage.module.css';
import { Popup } from '../Popup/Popup.tsx';
import { PopupVariant } from '../Popup/popupVariant.ts';
import { usePopupController } from '../Popup/popupController.ts';
import ScheduleForm, { ColorPicker } from './ScheduleForm.tsx';
import type {
  ScheduleColor,
  ScheduleCourse,
  ScheduleSession,
  ScheduleSessionInput,
  ScheduleSessionScope,
  ScheduleTask,
  ScheduleTaskInput,
} from '../../types/domain.ts';
import {
  COLORS,
  REMINDERS,
  dayTitle,
  draftError,
  draftToSession,
  draftToTask,
  formatRange,
  formatShortTime,
  formatTime,
  sessionDraft,
  taskDraft,
} from './schedule.ts';

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
  </svg>
);

export function Header({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <header className={styles.dialogHeader}>
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <button type="button" className={styles.closeButton} aria-label="Fermer" onClick={onClose}>
        <CloseIcon />
      </button>
    </header>
  );
}

const longDate = (iso: string) =>
  new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long' }).format(new Date(iso));

interface SessionPopupProps {
  session: ScheduleSession;
  course: ScheduleCourse;
  /** Couleur du cours dans l'horaire de l'utilisateur, qu'il peut changer. */
  color: ScheduleColor;
  onColorChange: (color: ScheduleColor) => void;
  onOpenCourse: () => void;
  onClose: () => void;
  /** Qui gère le cours : « Modifier » ouvre la fenêtre de modification de la séance. */
  onEdit?: () => void;
}

/** Détail d'une séance : quand, où, répétition ; « Voir le cours » ouvre le cours. */
export function SessionPopup({
  session,
  course,
  color,
  onColorChange,
  onOpenCourse,
  onClose,
  onEdit,
}: SessionPopupProps): React.ReactElement {
  const controller = usePopupController();
  /** Couleur essayée dans les pastilles ; « Appliquer » l'enregistre. */
  const [picked, setPicked] = useState(color);
  const title = `${course.code} · ${session.kind}`;
  const when = `${dayTitle(new Date(session.start))}, ${formatTime(session.start)} à ${formatTime(session.end)}`;
  const weekday = new Intl.DateTimeFormat('fr-CA', { weekday: 'long' }).format(
    new Date(session.start)
  );
  return (
    <Popup variant={PopupVariant.Form} label={title} onClose={onClose} controller={controller}>
      <div className={styles.dialog}>
        {/* Le sigle ouvre le cours. */}
        <header className={styles.dialogHeader}>
          <div>
            <h2>
              <button
                type="button"
                className={styles.courseLink}
                aria-label={`Voir le cours ${course.code}`}
                title="Voir le cours"
                data-autofocus
                onClick={() => controller.requestClose(onOpenCourse)}
              >
                {course.code}
              </button>{' '}
              · {session.kind}
            </h2>
            {course.title && <p>{course.title}</p>}
          </div>
          <button
            type="button"
            className={styles.closeButton}
            aria-label="Fermer"
            onClick={() => controller.requestClose()}
          >
            <CloseIcon />
          </button>
        </header>
        <dl className={styles.details}>
          <dt>Quand</dt>
          <dd>{when}</dd>
          <dt>Local</dt>
          <dd>{session.room}</dd>
          {session.until && (
            <>
              <dt>Répétition</dt>
              <dd>
                Chaque {weekday}, jusqu'au {longDate(session.until)}
              </dd>
            </>
          )}
        </dl>
        <ColorPicker
          legend="Ma couleur pour ce cours"
          value={picked}
          onChange={setPicked}
          tone="bright"
        />
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => controller.requestClose()}>
            Fermer
          </button>
          <span className={styles.spacer} />
          {/* « Appliquer » n'apparaît qu'après avoir choisi une autre couleur. */}
          {picked !== color && (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={() => {
                onColorChange(picked);
                controller.requestClose();
              }}
            >
              Appliquer
            </button>
          )}
          {onEdit && picked === color && (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={() => controller.requestClose(onEdit)}
            >
              Modifier
            </button>
          )}
        </div>
      </div>
    </Popup>
  );
}

interface TaskPopupProps {
  task: ScheduleTask;
  courses: ScheduleCourse[];
  onSave: (input: ScheduleTaskInput) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}

/** Modification d'une tâche, ouverte par un clic sur son bloc. */
export function TaskPopup({
  task,
  courses,
  onSave,
  onDelete,
  onClose,
}: TaskPopupProps): React.ReactElement {
  const controller = usePopupController();
  const [draft, setDraft] = useState(() => taskDraft(task));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      controller.requestClose();
    } catch {
      setError("L'enregistrement a échoué. Réessayez.");
      setBusy(false);
    }
  }

  return (
    <Popup
      variant={PopupVariant.Form}
      label="Modifier la tâche"
      onClose={onClose}
      controller={controller}
    >
      <div className={styles.dialog}>
        <Header title="Modifier la tâche" onClose={() => controller.requestClose()} />
        <ScheduleForm
          draft={draft}
          onChange={setDraft}
          courses={courses}
          error={error}
          busy={busy}
          submitLabel="Enregistrer"
          onSubmit={() => {
            const problem = draftError(draft);
            if (problem) setError(problem);
            else void run(() => onSave(draftToTask(draft)));
          }}
          onCancel={() => controller.requestClose()}
          onDelete={() => void run(onDelete)}
        />
      </div>
    </Popup>
  );
}

interface SessionEditPopupProps {
  session: ScheduleSession;
  courses: ScheduleCourse[];
  kinds: string[];
  onAddKind: (kind: string) => void;
  onDeleteKind: (kind: string) => void;
  onSave: (input: ScheduleSessionInput, scope: ScheduleSessionScope) => Promise<void>;
  onDelete: (scope: ScheduleSessionScope) => Promise<void>;
  onClose: () => void;
}

/**
 * Modification d'une séance par qui gère le cours : cours, type, jour, heures, local. Une séance
 * répétée se modifie seule ou avec toute sa série.
 */
export function SessionEditPopup({
  session,
  courses,
  kinds,
  onAddKind,
  onDeleteKind,
  onSave,
  onDelete,
  onClose,
}: SessionEditPopupProps): React.ReactElement {
  const controller = usePopupController();
  const [draft, setDraft] = useState(() => sessionDraft(session));
  const [scope, setScope] = useState<ScheduleSessionScope>('one');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inSeries = session.seriesId != null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      controller.requestClose();
    } catch {
      setError("L'enregistrement a échoué. Réessayez.");
      setBusy(false);
    }
  }

  const scopeField = inSeries ? (
    <div className={styles.field}>
      <span id={`session-scope-${session.id}`}>Appliquer à</span>
      <div className={styles.chips} role="group" aria-labelledby={`session-scope-${session.id}`}>
        <button type="button" aria-pressed={scope === 'one'} onClick={() => setScope('one')}>
          Cette séance
        </button>
        <button type="button" aria-pressed={scope === 'series'} onClick={() => setScope('series')}>
          Toutes les semaines
        </button>
      </div>
    </div>
  ) : null;

  return (
    <Popup
      variant={PopupVariant.Form}
      label="Modifier la séance"
      onClose={onClose}
      controller={controller}
    >
      <div className={styles.dialog}>
        <Header title="Modifier la séance" onClose={() => controller.requestClose()} />
        <ScheduleForm
          draft={draft}
          onChange={setDraft}
          courses={courses}
          kinds={kinds}
          onAddKind={onAddKind}
          onDeleteKind={onDeleteKind}
          error={error}
          busy={busy}
          submitLabel="Enregistrer"
          repeatField={scopeField}
          onSubmit={() => {
            const problem = draftError(draft);
            if (problem) setError(problem);
            else void run(() => onSave(draftToSession(draft), scope));
          }}
          onCancel={() => controller.requestClose()}
          onDelete={() => void run(() => onDelete(scope))}
        />
      </div>
    </Popup>
  );
}

interface DeadlinePopupProps {
  task: ScheduleTask;
  course: ScheduleCourse | undefined;
  onClose: () => void;
  /** « Voir le devoir » : ouvre le devoir dans le canal Devoirs du cours. */
  onOpenAssignment?: () => void;
}

/** Remise d'un devoir du cours, en lecture ; « Voir le devoir » l'ouvre dans Devoirs. */
export function DeadlinePopup({
  task,
  course,
  onClose,
  onOpenAssignment,
}: DeadlinePopupProps): React.ReactElement {
  const controller = usePopupController();
  const title = `Remise : ${task.title}`;
  return (
    <Popup variant={PopupVariant.Form} label={title} onClose={onClose} controller={controller}>
      <div className={styles.dialog}>
        <Header title={title} subtitle={course?.title} onClose={() => controller.requestClose()} />
        <dl className={styles.details}>
          {course && (
            <>
              <dt>Cours</dt>
              <dd>{course.code}</dd>
            </>
          )}
          <dt>Échéance</dt>
          <dd>
            {dayTitle(new Date(task.start))}, {formatTime(task.start)}
          </dd>
          <dt>État</dt>
          <dd>{task.done ? 'Remis' : 'À remettre'}</dd>
          {task.notes && (
            <>
              <dt>Description</dt>
              <dd className={styles.preLine}>{task.notes}</dd>
            </>
          )}
        </dl>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => controller.requestClose()}>
            Fermer
          </button>
          <span className={styles.spacer} />
          {onOpenAssignment && (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              data-autofocus
              onClick={() => controller.requestClose(onOpenAssignment)}
            >
              Voir le devoir
            </button>
          )}
        </div>
      </div>
    </Popup>
  );
}

interface TaskPreviewPopupProps {
  task: ScheduleTask;
  course: ScheduleCourse | undefined;
  onClose: () => void;
  /** « Modifier » : la fenêtre de modification de la tâche. */
  onEdit: () => void;
  /** Bouton « Marquer terminée » : reçoit la tâche dans son état courant. */
  onToggleDone: (task: ScheduleTask) => void;
}

/** Aperçu d'une tâche (ou d'une remise personnelle) : ce qu'elle est ; « Modifier » pour la changer. */
export function TaskPreviewPopup({
  task,
  course,
  onClose,
  onEdit,
  onToggleDone,
}: TaskPreviewPopupProps): React.ReactElement {
  const controller = usePopupController();
  /** État affiché : le bouton bascule sans fermer l'aperçu. */
  const [done, setDone] = useState(task.done);
  const when = task.allDay
    ? `${dayTitle(new Date(task.start))}, toute la journée`
    : task.deadline
      ? `${dayTitle(new Date(task.start))}, remise à ${formatShortTime(task.start)}`
      : `${dayTitle(new Date(task.start))}, ${formatRange(task.start, task.end)}`;
  const reminder = REMINDERS.find((r) => r.value === task.reminder && r.value != null)?.label;
  return (
    <Popup variant={PopupVariant.Form} label={task.title} onClose={onClose} controller={controller}>
      <div className={styles.dialog}>
        <header className={styles.dialogHeader}>
          <div>
            <h2 className={styles.previewTitle}>
              {/* Pastille de la couleur de la tâche (rouge pour une remise). */}
              <span
                className={`${styles.previewDot} ${task.deadline ? styles.previewDotDeadline : ''}`}
                style={{
                  ['--hue' as string]: COLORS[task.color].hue,
                  ['--sat' as string]: `${COLORS[task.color].saturation}%`,
                }}
                aria-hidden="true"
              />
              {task.title}
            </h2>
            <p>{task.deadline ? 'Remise personnelle' : 'Tâche personnelle'}</p>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            aria-label="Fermer"
            onClick={() => controller.requestClose()}
          >
            <CloseIcon />
          </button>
        </header>
        <dl className={styles.details}>
          <dt>Quand</dt>
          <dd>{when}</dd>
          {course && (
            <>
              <dt>Cours</dt>
              <dd>{course.title ? `${course.code} · ${course.title}` : course.code}</dd>
            </>
          )}
          {reminder && (
            <>
              <dt>Rappel</dt>
              <dd>{reminder}</dd>
            </>
          )}
          {task.notes && (
            <>
              <dt>Description</dt>
              <dd className={styles.preLine}>{task.notes}</dd>
            </>
          )}
        </dl>
        <div className={styles.actions}>
          {/* Bascule : vert et coché une fois terminée ; un clic la remet à faire. */}
          <button
            type="button"
            className={`${styles.button} ${styles.doneToggle}`}
            aria-pressed={done}
            onClick={() => {
              onToggleDone({ ...task, done });
              setDone(!done);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {done ? 'Terminée' : 'Marquer terminée'}
          </button>
          <span className={styles.spacer} />
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            data-autofocus
            onClick={() => controller.requestClose(onEdit)}
          >
            Modifier
          </button>
        </div>
      </div>
    </Popup>
  );
}
