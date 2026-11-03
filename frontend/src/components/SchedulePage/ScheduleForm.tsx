import React, { useId } from 'react';
import styles from './SchedulePage.module.css';
import type { ScheduleCourse } from '../../types/domain.ts';
import {
  COLORS,
  COLOR_KEYS,
  type Draft,
  type DraftKind,
  REMINDERS,
  SESSION_KINDS,
  TIME_OPTIONS,
} from './schedule.ts';

interface ScheduleFormProps {
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** Cours de l'utilisateur ; ceux qu'il gère (`canManage`) peuvent recevoir une séance. */
  courses: ScheduleCourse[];
  /** Ajout : onglets « Tâche » et « Séance du cours » si l'utilisateur gère un cours. */
  allowSessions?: boolean;
  /** Message affiché après une tentative d'enregistrement refusée. */
  error: string | null;
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  /** Modification : bouton « Supprimer ». */
  onDelete?: () => void;
}

/** Formulaire d'une tâche ou d'une séance : panneau d'ajout et fenêtre de modification. */
export default function ScheduleForm({
  draft,
  onChange,
  courses,
  allowSessions = false,
  error,
  busy = false,
  submitLabel,
  onSubmit,
  onCancel,
  onDelete,
}: ScheduleFormProps): React.ReactElement {
  const id = useId();
  const managed = courses.filter((course) => course.canManage);
  const set = (changes: Partial<Draft>) => onChange({ ...draft, ...changes });
  const isTask = draft.kind === 'task';

  function switchKind(kind: DraftKind) {
    if (kind === draft.kind) return;
    set({ kind, courseId: kind === 'session' ? (managed[0]?.id ?? null) : null });
  }

  const timeSelect = (field: 'start' | 'end', label: string) => (
    <label className={styles.field}>
      <span>{label}</span>
      <select value={draft[field]} onChange={(event) => set({ [field]: event.target.value })}>
        {TIME_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {allowSessions && managed.length > 0 && (
        <div className={styles.tabs} role="group" aria-label="Type d'ajout">
          <button type="button" aria-pressed={isTask} onClick={() => switchKind('task')}>
            Tâche
          </button>
          <button type="button" aria-pressed={!isTask} onClick={() => switchKind('session')}>
            Séance du cours
          </button>
        </div>
      )}

      {isTask ? (
        <label className={styles.field}>
          <span>Titre</span>
          <input
            type="text"
            value={draft.title}
            maxLength={80}
            data-autofocus
            onChange={(event) => set({ title: event.target.value })}
          />
        </label>
      ) : (
        <>
          <label className={styles.field}>
            <span>Cours</span>
            <select
              value={draft.courseId ?? ''}
              onChange={(event) => set({ courseId: Number(event.target.value) })}
            >
              {managed.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.title ? `${course.code} · ${course.title}` : course.code}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Type</span>
            <select value={draft.sessionKind} onChange={(event) => set({ sessionKind: event.target.value })}>
              {SESSION_KINDS.map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </select>
          </label>
        </>
      )}

      <label className={styles.field}>
        <span>Date</span>
        <input type="date" value={draft.date} onChange={(event) => set({ date: event.target.value })} />
      </label>
      <div className={styles.fieldRow}>
        {timeSelect('start', 'Début')}
        {timeSelect('end', 'Fin')}
      </div>

      {isTask ? (
        <>
          <fieldset className={styles.colors}>
            <legend>Couleur</legend>
            <div>
              {COLOR_KEYS.map((key) => (
                <input
                  key={key}
                  type="radio"
                  name={`${id}-color`}
                  aria-label={COLORS[key].label}
                  checked={draft.color === key}
                  style={{ ['--hue' as string]: COLORS[key].hue, ['--sat' as string]: `${COLORS[key].saturation}%` }}
                  onChange={() => set({ color: key })}
                />
              ))}
            </div>
          </fieldset>
          <label className={styles.field}>
            <span>Cours lié (facultatif)</span>
            <select
              value={draft.courseId ?? ''}
              onChange={(event) => set({ courseId: event.target.value ? Number(event.target.value) : null })}
            >
              <option value="">Aucun</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.code}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Rappel</span>
            <select
              value={draft.reminder ?? ''}
              onChange={(event) => set({ reminder: event.target.value ? Number(event.target.value) : null })}
            >
              {REMINDERS.map((reminder) => (
                <option key={reminder.label} value={reminder.value ?? ''}>
                  {reminder.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Notes (facultatif)</span>
            <textarea
              rows={2}
              value={draft.notes}
              maxLength={500}
              onChange={(event) => set({ notes: event.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span>Local</span>
            <input type="text" value={draft.room} maxLength={20} onChange={(event) => set({ room: event.target.value })} />
          </label>
          <div className={styles.field}>
            <span id={`${id}-repeat`}>Répétition</span>
            <div className={styles.chips} role="group" aria-labelledby={`${id}-repeat`}>
              <button type="button" aria-pressed={!draft.weekly} onClick={() => set({ weekly: false })}>
                Une fois
              </button>
              <button
                type="button"
                aria-pressed={draft.weekly}
                onClick={() => set({ weekly: true, until: draft.until || draft.date })}
              >
                Chaque semaine
              </button>
            </div>
          </div>
          {draft.weekly && (
            <label className={styles.field}>
              <span>Jusqu'au</span>
              <input type="date" value={draft.until} onChange={(event) => set({ until: event.target.value })} />
            </label>
          )}
          <p className={styles.hint}>Les étudiants du cours la verront, sans pouvoir la déplacer.</p>
        </>
      )}

      {error && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        {onDelete && (
          <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy} onClick={onDelete}>
            Supprimer
          </button>
        )}
        <span className={styles.spacer} />
        <button type="button" className={styles.button} onClick={onCancel}>
          Annuler
        </button>
        <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
