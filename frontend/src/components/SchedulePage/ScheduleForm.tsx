import React, { useEffect, useId, useRef, useState } from 'react';
import styles from './SchedulePage.module.css';
import type { ScheduleColor, ScheduleCourse } from '../../types/domain.ts';
import {
  COLORS,
  COLOR_KEYS,
  DEADLINE_OPTIONS,
  type Draft,
  REMINDERS,
  SESSION_KINDS,
  TIME_OPTIONS,
} from './schedule.ts';

interface ScheduleFormProps {
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** Cours de l'utilisateur ; ceux qu'il gère (`canManage`) peuvent recevoir une séance. */
  courses: ScheduleCourse[];
  /** Types de séance ajoutés par l'utilisateur, après ceux de la liste. */
  extraKinds?: string[];
  onAddKind?: (kind: string) => void;
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

const ADD_KIND = '__ajouter__';

/**
 * Type d'une séance : une liste, avec « Ajouter un type… » en dernier ; le type ajouté rejoint la
 * liste et devient celui de la séance.
 */
function KindField({
  value,
  extraKinds,
  onChange,
  onAddKind,
}: {
  value: string;
  extraKinds: string[];
  onChange: (kind: string) => void;
  onAddKind?: (kind: string) => void;
}): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();
  const known = [...SESSION_KINDS, ...extraKinds];
  const kinds = known.includes(value) || !value ? known : [...known, value];

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  function add() {
    const kind = text.trim();
    if (!kind) return;
    const existing = kinds.find((known) => known.toLowerCase() === kind.toLowerCase());
    if (!existing) onAddKind?.(kind);
    onChange(existing ?? kind);
    setText('');
    setAdding(false);
  }

  // « Ajouter un type… » change la liste en champ, au même endroit ; « Ajouter » le sélectionne.
  return (
    <div className={styles.field}>
      <label htmlFor={fieldId} className={styles.kindLabel}>
        Type
      </label>
      {adding ? (
        <div className={styles.addKind}>
          <input
            ref={inputRef}
            id={fieldId}
            type="text"
            placeholder="Séminaire, Examen…"
            maxLength={24}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Entrée ajoute le type sans envoyer le formulaire ; Échap revient à la liste sans fermer la fenêtre.
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              } else if (event.key === 'Escape') {
                event.stopPropagation();
                setAdding(false);
              }
            }}
          />
          <button type="button" className={styles.button} disabled={!text.trim()} onClick={add}>
            Ajouter
          </button>
        </div>
      ) : (
        <select
          id={fieldId}
          value={value}
          onChange={(event) => {
            if (event.target.value === ADD_KIND) setAdding(true);
            else onChange(event.target.value);
          }}
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
          <option value={ADD_KIND}>＋ Ajouter un type…</option>
        </select>
      )}
    </div>
  );
}

/** Formulaire d'une tâche ou d'une séance : panneau d'ajout et fenêtre de modification. */
export default function ScheduleForm({
  draft,
  onChange,
  courses,
  extraKinds = [],
  onAddKind,
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
  /** Remise personnelle de l'étudiant (celles d'un cours viennent de ses devoirs). */
  const isDeadline = isTask && draft.deadline;

  const managedCourseSelect = (
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
  );

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
      {/* Étudiant : une tâche, ou une remise à lui (une seule heure, l'échéance). */}
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
              onClick={() => set({ deadline: true, allDay: false })}
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
          {managedCourseSelect}
          <KindField
            value={draft.sessionKind}
            extraKinds={extraKinds}
            onChange={(sessionKind) => set({ sessionKind })}
            onAddKind={onAddKind}
          />
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
      {isTask && !isDeadline && onDelete && (
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
          {
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
          }
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
