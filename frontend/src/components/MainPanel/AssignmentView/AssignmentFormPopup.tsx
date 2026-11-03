import React, { useLayoutEffect, useRef, useState } from 'react';
import styles from './AssignmentFormPopup.module.css';
import { Popup } from '../../Popup/Popup';
import { PopupVariant } from '../../Popup/popupVariant';
import { usePopupController } from '../../Popup/popupController';
import { FILE_FORMATS, clampInput } from './assignmentFormat.ts';
import type {
  Assignment,
  AssignmentDraft,
  AssignmentFile,
  TeamFormation,
} from '../../../types/domain.ts';

const WIDTH = { '--popup-width': '40rem' } as React.CSSProperties;
const DEFAULT_TIME = '23:59';
const DEFAULT_TEAM_SIZE = 4;
const MAX_TEAM_SIZE = 10;

interface AssignmentFormPopupProps {
  /** Sous-titre : le cours. */
  courseLabel: string;
  /** Devoir à modifier ; absent : nouveau devoir. */
  assignment?: Assignment;
  onClose: () => void;
  /** Le parent enregistre ; un rejet garde la fenêtre ouverte et affiche l'erreur. */
  onSave: (draft: AssignmentDraft) => Promise<unknown>;
}

const pad = (n: number) => String(n).padStart(2, '0');

function dateInput(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeInput(iso?: string): string {
  if (!iso) return DEFAULT_TIME;
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** « 240 Ko » : la taille d'un fichier joint. */
function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

/** Fenêtre « Nouveau devoir » du prof. Toute remise est un fichier ; son format est facultatif. */
export function AssignmentFormPopup({
  courseLabel,
  assignment,
  onClose,
  onSave,
}: AssignmentFormPopupProps): React.ReactElement {
  const popup = usePopupController();
  const [title, setTitle] = useState(assignment?.title ?? '');
  const [instructions, setInstructions] = useState(assignment?.instructions ?? '');
  const [date, setDate] = useState(dateInput(assignment?.dueAt));
  const [time, setTime] = useState(timeInput(assignment?.dueAt));
  const [weight, setWeight] = useState(assignment?.weight?.toString() ?? '');
  const [formats, setFormats] = useState<string[]>(assignment?.expectedFormats ?? []);
  const [isTeam, setIsTeam] = useState(assignment?.teamSize != null);
  const [teamSize, setTeamSize] = useState(String(assignment?.teamSize ?? DEFAULT_TEAM_SIZE));
  const [teamFormation, setTeamFormation] = useState<TeamFormation>(
    assignment?.teamFormation ?? 'students'
  );
  const [otherOpen, setOtherOpen] = useState(false);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);

  // La zone des consignes grandit avec son texte : on voit toute la description.
  useLayoutEffect(() => {
    const area = instructionsRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  }, [instructions]);
  const [other, setOther] = useState('');
  const [files, setFiles] = useState<AssignmentFile[]>(assignment?.files ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isPublished = assignment?.isPublished ?? false;
  // Les extensions proposées, puis celles que le prof a ajoutées (« Autre »).
  const formatChoices = [
    ...FILE_FORMATS,
    ...formats.filter((format) => !FILE_FORMATS.includes(format)),
  ];

  function toggleFormat(format: string) {
    setFormats((previous) =>
      previous.includes(format) ? previous.filter((f) => f !== format) : [...previous, format]
    );
  }

  function addOtherFormat() {
    const raw = other.trim().toLowerCase();
    if (raw) {
      const format = raw.startsWith('.') ? raw : `.${raw}`;
      setFormats((previous) => (previous.includes(format) ? previous : [...previous, format]));
    }
    setOther('');
    setOtherOpen(false);
  }

  async function save(publish: boolean) {
    if (!title.trim()) {
      setError('Donnez un titre au devoir.');
      return;
    }
    if (publish && !date) {
      setError('Choisissez une date limite pour publier le devoir.');
      return;
    }
    if (isTeam && !(Number(teamSize) >= 2)) {
      setError('Une équipe compte au moins 2 membres.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        instructions: instructions.trim(),
        dueAt: date ? new Date(`${date}T${time || DEFAULT_TIME}`).toISOString() : undefined,
        weight: weight === '' ? undefined : Number(weight),
        expectedFormats: formats,
        files,
        isPublished: publish,
        teamSize: isTeam ? Number(teamSize) : undefined,
        teamFormation: isTeam ? teamFormation : undefined,
      });
      popup.requestClose(onClose);
    } catch {
      setError("Le devoir n'a pas pu être enregistré. Réessayez.");
      setSaving(false);
    }
  }

  return (
    <Popup
      variant={PopupVariant.FormWide}
      label={assignment ? 'Modifier le devoir' : 'Nouveau devoir'}
      onClose={onClose}
      controller={popup}
      panelStyle={WIDTH}
    >
      <form
        className={styles.form}
        // Les erreurs s'affichent dans la fenêtre, en français, plutôt que par le navigateur.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save(true);
        }}
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h1>{assignment ? 'Modifier le devoir' : 'Nouveau devoir'}</h1>
            <p>{courseLabel}</p>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Fermer"
            onClick={() => popup.requestClose(onClose)}
          >
            ✕
          </button>
        </header>

        <div className={styles.body}>
          <label className={styles.field}>
            <span>Titre</span>
            <input
              type="text"
              value={title}
              maxLength={120}
              placeholder="Devoir 6 : Arbres AVL"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className={styles.field}>
            <span>Consignes</span>
            <textarea
              ref={instructionsRef}
              className={styles.instructions}
              rows={3}
              value={instructions}
              placeholder="Ce que les étudiants doivent faire et remettre."
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>

          <div className={styles.row}>
            <label className={styles.field}>
              <span>Date limite</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label className={styles.field}>
              <span>Heure</span>
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
            <label className={styles.field}>
              <span>Pondération (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={weight}
                onChange={(event) => setWeight(clampInput(event.target.value, 100))}
              />
            </label>
          </div>

          <div className={styles.field} role="group" aria-labelledby="assignment-work">
            <span id="assignment-work">Travail</span>
            <div className={styles.chips}>
              {[
                { label: 'Individuel', team: false },
                { label: 'En équipe', team: true },
              ].map(({ label, team }) => (
                <button
                  key={label}
                  type="button"
                  className={`${styles.chip} ${isTeam === team ? styles.chipOn : ''}`}
                  aria-pressed={isTeam === team}
                  onClick={() => setIsTeam(team)}
                >
                  {label}
                </button>
              ))}
              {isTeam && (
                <label className={styles.teamSize}>
                  <span>Maximum par équipe</span>
                  <input
                    type="number"
                    min={2}
                    max={MAX_TEAM_SIZE}
                    value={teamSize}
                    onChange={(event) =>
                      setTeamSize(clampInput(event.target.value, MAX_TEAM_SIZE))
                    }
                  />
                </label>
              )}
            </div>
            {isTeam && (
              <p className={styles.hint}>
                Une seule remise par équipe, que chaque membre peut voir et remplacer.
              </p>
            )}
          </div>

          {isTeam && (
            <div className={styles.field} role="group" aria-labelledby="assignment-formation">
              <span id="assignment-formation">Qui forme les équipes ?</span>
              <div className={styles.chips}>
                {(
                  [
                    { label: 'Les étudiants', value: 'students' },
                    { label: 'Moi', value: 'teacher' },
                  ] as const
                ).map(({ label, value }) => (
                  <button
                    key={value}
                    type="button"
                    className={`${styles.chip} ${teamFormation === value ? styles.chipOn : ''}`}
                    aria-pressed={teamFormation === value}
                    onClick={() => setTeamFormation(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className={styles.hint}>
                {teamFormation === 'students'
                  ? 'Les étudiants rejoignent ou créent une équipe depuis le devoir.'
                  : 'Vous formez les équipes depuis le suivi du devoir, une fois publié.'}
              </p>
            </div>
          )}

          <div className={styles.field} role="group" aria-labelledby="assignment-formats">
            <span id="assignment-formats">Format de fichier attendu (facultatif)</span>
            <div className={styles.chips}>
              {formatChoices.map((format) => {
                const selected = formats.includes(format);
                return (
                  <button
                    key={format}
                    type="button"
                    className={`${styles.chip} ${selected ? styles.chipOn : ''}`}
                    aria-pressed={selected}
                    onClick={() => toggleFormat(format)}
                  >
                    {selected && <span aria-hidden="true">✓</span>}
                    {format}
                  </button>
                );
              })}
              {otherOpen ? (
                <input
                  className={styles.otherInput}
                  aria-label="Autre format"
                  placeholder=".py"
                  autoFocus
                  value={other}
                  onChange={(event) => setOther(event.target.value)}
                  onBlur={addOtherFormat}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addOtherFormat();
                    } else if (event.key === 'Escape') {
                      // Échap ferme ce champ seulement, pas toute la fenêtre.
                      event.stopPropagation();
                      setOther('');
                      setOtherOpen(false);
                    }
                  }}
                />
              ) : (
                <button type="button" className={styles.chip} onClick={() => setOtherOpen(true)}>
                  <span aria-hidden="true">+</span>
                  Autre
                </button>
              )}
            </div>
            <p className={styles.hint}>Sans choix, tous les formats sont acceptés.</p>
          </div>

          <div className={styles.field}>
            <span>Fichiers du devoir (facultatif)</span>
            <label className={styles.drop}>
              <input
                type="file"
                multiple
                className={styles.fileInput}
                aria-label="Ajouter des fichiers au devoir"
                onChange={(event) => {
                  const added = [...(event.target.files ?? [])].map((file) => ({
                    name: file.name,
                    size: fileSize(file.size),
                  }));
                  setFiles((previous) => [...previous, ...added]);
                  event.target.value = '';
                }}
              />
              Glissez un énoncé ici, ou cliquez pour le choisir
            </label>
            {files.length > 0 && (
              <ul className={styles.files}>
                {files.map((file) => (
                  <li key={file.name}>
                    <span>
                      {file.name} ({file.size})
                    </span>
                    <button
                      type="button"
                      aria-label={`Retirer ${file.name}`}
                      onClick={() =>
                        setFiles((previous) => previous.filter((f) => f.name !== file.name))
                      }
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.button}
            onClick={() => popup.requestClose(onClose)}
          >
            Annuler
          </button>
          <span className={styles.spacer} />
          {!isPublished && (
            <button
              type="button"
              className={styles.button}
              disabled={saving}
              onClick={() => void save(false)}
            >
              Enregistrer le brouillon
            </button>
          )}
          <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={saving}>
            {isPublished ? 'Enregistrer' : 'Publier le devoir'}
          </button>
        </footer>
      </form>
    </Popup>
  );
}
