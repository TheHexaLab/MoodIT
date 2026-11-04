import React, { useId } from 'react';
import styles from './SchedulePage.module.css';
import type { ScheduleColor, ScheduleCourse } from '../../types/domain.ts';
import {
  COLORS,
  COLOR_KEYS,
  DEADLINE_OPTIONS,
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

/** Pastilles de couleur : des boutons radio natifs, redessinés. */
export function ColorPicker({
  legend,
  value,
  onChange,
  tone = 'pastel',
}: {
  legend: string;
  value: ScheduleColor;
  onChange: (color: ScheduleColor) => void;
  /** Vif pour un cours, pastel pour une tâche : comme leurs blocs dans la grille. */
  tone?: 'bright' | 'pastel';
}): React.ReactElement {
  const name = useId();
  return (
    <fieldset className={styles.colors} data-tone={tone}>
      <legend>{legend}</legend>
      <div>
        {COLOR_KEYS.map((key) => (
          <input
            key={key}
            type="radio"
            name={name}
            aria-label={COLORS[key].label}
            checked={value === key}
            style={{
              ['--hue' as string]: COLORS[key].hue,
              ['--sat' as string]: `${COLORS[key].saturation}%`,
            }}
            onChange={() => onChange(key)}
          />
        ))}
      </div>
    </fieldset>
  );
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

      {isTask && (
        <div className={styles.field}>
          <span id={`${id}-genre`}>Genre</span>
          <div className={styles.chips} role="group" aria-labelledby={`${id}-genre`}>
            <button
              type="button"
              aria-pressed={!draft.deadline}
              onClick={() => set({ deadline: false })}
            >
              Tâche
            </button>
            <button
              type="button"
              aria-pressed={draft.deadline}
              onClick={() => set({ deadline: true })}
            >
              Remise
            </button>
          </div>
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
            <select
              value={draft.sessionKind}
              onChange={(event) => set({ sessionKind: event.target.value })}
            >
              {SESSION_KINDS.map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </select>
          </label>
        </>
      )}

      <label className={styles.field}>
        <span>Date</span>
        <input
          type="date"
          value={draft.date}
          onChange={(event) => set({ date: event.target.value })}
        />
      </label>
      {isTask && !draft.deadline && (
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={draft.allDay}
            onChange={(event) => set({ allDay: event.target.checked })}
          />
          <span>Toute la journée</span>
        </label>
      )}
      {isTask && onDelete && (
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={draft.done}
            onChange={(event) => set({ done: event.target.checked })}
          />
          <span>Tâche terminée</span>
        </label>
      )}
      {isTask && draft.deadline && (
        <label className={styles.field}>
          <span>Heure limite</span>
          <select value={draft.start} onChange={(event) => set({ start: event.target.value })}>
            {DEADLINE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {!(isTask && (draft.allDay || draft.deadline)) && (
        <div className={styles.fieldRow}>
          {timeSelect('start', 'Début')}
          {timeSelect('end', 'Fin')}
        </div>
      )}

      {isTask ? (
        <>
          {!draft.deadline && (
            <ColorPicker
              legend="Couleur"
              value={draft.color}
              onChange={(color) => set({ color })}
            />
          )}
          <label className={styles.field}>
            <span>Cours lié (facultatif)</span>
            <select
              value={draft.courseId ?? ''}
              onChange={(event) =>
                set({ courseId: event.target.value ? Number(event.target.value) : null })
              }
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
              onChange={(event) =>
                set({ reminder: event.target.value ? Number(event.target.value) : null })
              }
            >
              {REMINDERS.map((reminder) => (
                <option key={reminder.label} value={reminder.value ?? ''}>
                  {reminder.label}
                </option>
              ))}
            </select>
          </label>
          {/* La description s'agrandit avec son texte : elle se lit toujours en entier. */}
          <label className={`${styles.field} ${styles.fieldGrow}`}>
            <span>Description</span>
            <textarea
              rows={3}
              value={draft.notes}
              maxLength={2000}
              onChange={(event) => set({ notes: event.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span>Local</span>
            <input
              type="text"
              value={draft.room}
              maxLength={20}
              onChange={(event) => set({ room: event.target.value })}
            />
          </label>
          <div className={styles.field}>
            <span id={`${id}-repeat`}>Répétition</span>
            <div className={styles.chips} role="group" aria-labelledby={`${id}-repeat`}>
              <button
                type="button"
                aria-pressed={!draft.weekly}
                onClick={() => set({ weekly: false })}
              >
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
              <input
                type="date"
                value={draft.until}
                onChange={(event) => set({ until: event.target.value })}
              />
            </label>
          )}
          <p className={styles.hint}>
            Les étudiants du cours la verront, sans pouvoir la déplacer.
          </p>
        </>
      )}

      {error && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        {onDelete && (
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            disabled={busy}
            onClick={onDelete}
          >
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
