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
  ScheduleTask,
  ScheduleTaskInput,
} from '../../types/domain.ts';
import { dayTitle, draftError, draftToTask, formatTime, taskDraft } from './schedule.ts';

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
}

/** Détail d'une séance : quand, où, répétition ; « Voir le cours » ouvre le cours. */
export function SessionPopup({
  session,
  course,
  color,
  onColorChange,
  onOpenCourse,
  onClose,
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

interface DeadlinePopupProps {
  task: ScheduleTask;
  course: ScheduleCourse | undefined;
  onClose: () => void;
}

/** Remise d'un cours, en lecture : l'étudiant la voit, l'enseignant du cours la modifie. */
export function DeadlinePopup({ task, course, onClose }: DeadlinePopupProps): React.ReactElement {
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
          {task.notes && (
            <>
              <dt>Description</dt>
              <dd className={styles.preLine}>{task.notes}</dd>
            </>
          )}
        </dl>
        <div className={styles.actions}>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.button}
            data-autofocus
            onClick={() => controller.requestClose()}
          >
            Fermer
          </button>
        </div>
      </div>
    </Popup>
  );
}
