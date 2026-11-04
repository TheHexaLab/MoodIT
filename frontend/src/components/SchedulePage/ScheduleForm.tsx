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
  /** Types de séance de la liste, que l'enseignant ajoute ou supprime. */
  kinds?: string[];
  onAddKind?: (kind: string) => void;
  onDeleteKind?: (kind: string) => void;
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

const ChevronDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path
      d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface DropdownItem {
  key: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  /** Corbeille à côté de l'élément (types de séance). */
  onDelete?: () => void;
  deleteLabel?: string;
}

/**
 * Liste déroulante maison : un bouton qui montre le choix, et une liste de boutons dessous. Choisir
 * referme la liste et rend le focus au bouton ; une corbeille la garde ouverte. Flèches pour passer
 * d'un élément à l'autre, Échap pour refermer (sans fermer la fenêtre), clic ailleurs aussi.
 * `footer` ajoute une ligne en bas (« Ajouter un type… ») ; elle reçoit de quoi refermer la liste.
 */
function Dropdown({
  id,
  labelId,
  display,
  menuLabel,
  items,
  footer,
}: {
  id: string;
  labelId: string;
  display: string;
  menuLabel: string;
  items: DropdownItem[];
  footer?: (close: () => void) => React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const options = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[data-kind-option]') ?? []),
  ];

  // Liste ouverte : le focus va à l'élément choisi ; un clic ailleurs la referme.
  useEffect(() => {
    if (!open) return;
    (options().find((el) => el.getAttribute('aria-pressed') === 'true') ?? options()[0])?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div ref={rootRef} className={styles.kindPicker}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={styles.kindTrigger}
        aria-haspopup="true"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${id}-value`}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span id={`${id}-value`}>{display}</span>
        <ChevronDown />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={styles.kindMenu}
          role="group"
          aria-label={menuLabel}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const all = options();
              const index = all.indexOf(document.activeElement as HTMLElement);
              const step = event.key === 'ArrowDown' ? 1 : -1;
              all[(index + step + all.length) % all.length]?.focus();
            }
          }}
        >
          {items.map((item) => (
            <div key={item.key} className={styles.kindRow}>
              <button
                type="button"
                className={styles.kindOption}
                data-kind-option
                aria-pressed={item.selected}
                onClick={() => {
                  item.onSelect();
                  close();
                }}
              >
                {item.label}
              </button>
              {item.onDelete && (
                <button
                  type="button"
                  className={styles.kindDelete}
                  aria-label={item.deleteLabel}
                  onClick={() => {
                    item.onDelete?.();
                    // La liste reste ouverte ; le focus revient au premier élément.
                    window.requestAnimationFrame(() => options()[0]?.focus());
                  }}
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}
          {footer?.(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * Type d'une séance : la liste déroulante, chaque type avec sa corbeille ; « Ajouter un type… », en
 * bleu, change la liste en champ au même endroit, et « Ajouter » le sélectionne.
 */
function KindField({
  value,
  kinds: known,
  onChange,
  onAddKind,
  onDeleteKind,
}: {
  value: string;
  kinds: string[];
  onChange: (kind: string) => void;
  onAddKind?: (kind: string) => void;
  onDeleteKind?: (kind: string) => void;
}): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();
  const kinds = known.includes(value) || !value ? known : [...known, value];

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  function remove(kind: string) {
    onDeleteKind?.(kind);
    // Le type choisi supprimé : le premier qui reste le remplace (aucun si la liste est vide).
    if (value === kind) onChange(known.find((other) => other !== kind) ?? '');
  }

  function add() {
    const kind = text.trim();
    if (!kind) return;
    const existing = kinds.find((known) => known.toLowerCase() === kind.toLowerCase());
    if (!existing) onAddKind?.(kind);
    onChange(existing ?? kind);
    setText('');
    setAdding(false);
  }

  return (
    <div className={styles.field}>
      <label id={`${fieldId}-label`} htmlFor={fieldId} className={styles.kindLabel}>
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
        <Dropdown
          id={fieldId}
          labelId={`${fieldId}-label`}
          display={value || 'Choisir un type'}
          menuLabel="Types de séance"
          items={kinds.map((kind) => ({
            key: kind,
            label: kind,
            selected: kind === value,
            onSelect: () => onChange(kind),
            onDelete: () => remove(kind),
            deleteLabel: `Supprimer le type « ${kind} »`,
          }))}
          footer={(closeMenu) => (
            <button
              type="button"
              className={styles.kindAdd}
              data-kind-option
              onClick={() => {
                closeMenu();
                setAdding(true);
              }}
            >
              ＋ Ajouter un type…
            </button>
          )}
        />
      )}
    </div>
  );
}

/** Formulaire d'une tâche ou d'une séance : panneau d'ajout et fenêtre de modification. */
export default function ScheduleForm({
  draft,
  onChange,
  courses,
  kinds = SESSION_KINDS,
  onAddKind,
  onDeleteKind,
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

  const courseLabel = (course: ScheduleCourse) =>
    course.title ? `${course.code} · ${course.title}` : course.code;
  const chosenCourse = managed.find((course) => course.id === draft.courseId);
  // Cours d'une séance : la même liste déroulante que le type, sans corbeille.
  const managedCourseSelect = (
    <div className={styles.field}>
      <label id={`${id}-course-label`} htmlFor={`${id}-course`} className={styles.kindLabel}>
        Cours
      </label>
      <Dropdown
        id={`${id}-course`}
        labelId={`${id}-course-label`}
        display={chosenCourse ? courseLabel(chosenCourse) : 'Choisir un cours'}
        menuLabel="Mes cours"
        items={managed.map((course) => ({
          key: String(course.id),
          label: courseLabel(course),
          selected: course.id === draft.courseId,
          onSelect: () => set({ courseId: course.id }),
        }))}
      />
    </div>
  );

  /** Un champ à liste déroulante (la même que Cours et Type) : libellé, choix affiché, éléments. */
  const pickField = (key: string, label: string, display: string, items: DropdownItem[]) => (
    <div className={styles.field}>
      <label id={`${id}-${key}-label`} htmlFor={`${id}-${key}`} className={styles.kindLabel}>
        {label}
      </label>
      <Dropdown
        id={`${id}-${key}`}
        labelId={`${id}-${key}-label`}
        display={display}
        menuLabel={label}
        items={items}
      />
    </div>
  );

  const timeOptions = (options: { value: string; label: string }[], field: 'start' | 'end') =>
    options.map((option) => ({
      key: option.value,
      label: option.label,
      selected: draft[field] === option.value,
      onSelect: () => set({ [field]: option.value }),
    }));
  const timeLabel = (options: { value: string; label: string }[], value: string) =>
    options.find((option) => option.value === value)?.label ?? value;

  const timeSelect = (field: 'start' | 'end', label: string) =>
    pickField(
      field,
      label,
      timeLabel(TIME_OPTIONS, draft[field]),
      timeOptions(TIME_OPTIONS, field)
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
            kinds={kinds}
            onChange={(sessionKind) => set({ sessionKind })}
            onAddKind={onAddKind}
            onDeleteKind={onDeleteKind}
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
      {isTask &&
        draft.deadline &&
        pickField(
          'due',
          'Heure limite',
          timeLabel(DEADLINE_OPTIONS, draft.start),
          timeOptions(DEADLINE_OPTIONS, 'start')
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
          {pickField(
            'linked',
            'Cours lié (facultatif)',
            courses.find((course) => course.id === draft.courseId)?.code ?? 'Aucun',
            [
              {
                key: 'none',
                label: 'Aucun',
                selected: draft.courseId == null,
                onSelect: () => set({ courseId: null }),
              },
              ...courses.map((course) => ({
                key: String(course.id),
                label: course.code,
                selected: course.id === draft.courseId,
                onSelect: () => set({ courseId: course.id }),
              })),
            ]
          )}
          {pickField(
            'reminder',
            'Rappel',
            REMINDERS.find((reminder) => reminder.value === draft.reminder)?.label ??
              'Aucun rappel',
            REMINDERS.map((reminder) => ({
              key: reminder.label,
              label: reminder.label,
              selected: reminder.value === draft.reminder,
              onSelect: () => set({ reminder: reminder.value }),
            }))
          )}
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
