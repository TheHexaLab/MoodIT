import React from 'react';
import styles from './ProgramMenu.module.css';
import { type Course } from '../CourseMenu/CourseMenu.tsx';
import { useTheme } from '../../helpers/theme.ts';
import { contrastingTextColor } from '../../helpers/color.ts';
// DEV : clic droit sur l'icone de l'app → menu de test des WebSockets.
import { WsTestContextMenu } from '../../dev/WsTestContextMenu.tsx';

export interface Program {
  /** Identifiant du programme (Program.id, SERIAL). */
  id: number;
  /** Libelle UI optionnel (override l'affichage par defaut). */
  label?: string;
  /** Nom du programme (Program.name), ex. "Genie informatique". */
  name: string;
  /** Code du programme (Program.code), ex. "GIN". */
  code: string;
  /** Cohorte du programme (Program.cohort), ex. "71". */
  cohort: string;
  /** Couleur du programme (Program.color), ex. "#1a6e3c". */
  color: string;
  /** Cours rattaches au programme. */
  courses?: Course[];
}

interface ProgramMenuProps {
  /** Programmes assignes a l'utilisateur. */
  programs?: Program[];
  /** Programme actuellement selectionne. */
  activeProgramId?: number;
  /** Callback de selection d'un programme. */
  onSelectProgram?: (id: number) => void;
  /** Callback du bouton d'ajout (implementation a venir). */
  onAddProgram?: () => void;
}

/**
 * Construit des initiales courtes a partir d'un libelle.
 * - Mot unique: prend les 2 premieres lettres (ex: "math" -> "MA").
 * - Plusieurs mots: prend la premiere lettre de chaque mot (max 2, ex: "Genie Informatique" -> "GI").
 */
function getInitials(label: string): string {
  const normalized = label.trim();
  if (normalized === '') return '';

  const words = normalized.split(/\s+/).filter(Boolean);

  if (words.length > 1) {
    return words
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return normalized.slice(0, 2).toUpperCase();
}

/**
 * Retourne le texte a afficher pour un programme (tooltip / aria-label).
 * Priorite: label UI > nom backend > cohorte backend.
 */
function getProgramLabel(program: Program): string {
  const displayLabel = program.label ?? program.name ?? program.cohort ?? '';
  return displayLabel.trim();
}

/**
 * Texte court affiche dans la pastille du programme.
 * Priorite: code backend (ex. "GIN") > initiales du libelle.
 */
function getProgramBadge(program: Program): string {
  const code = program.code?.trim();
  if (code) return code.slice(0, 3).toUpperCase();
  return getInitials(getProgramLabel(program));
}

const ProgramMenu: React.FC<ProgramMenuProps> = ({
  programs = [],
  activeProgramId,
  onSelectProgram,
  onAddProgram,
}) => {
  const { toggleTheme } = useTheme()
  return (
    <nav className={styles.rail} aria-label="Programme">
      {/* Icône applicative (meme gabarit que le programme actif).
          Clic gauche = bascule le theme ; clic droit = menu de test WS (DEV). */}
      <WsTestContextMenu>
        <div className={styles.appIcon} aria-label="MoodIT" onClick={toggleTheme}>
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true">
            <defs>
              <linearGradient
                id="pg-grad"
                x1="0"
                y1="0"
                x2="36"
                y2="36"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0%" stopColor="#2dd4bf" />
                <stop offset="100%" stopColor="#0d9488" />
              </linearGradient>
            </defs>
            <rect width="36" height="36" rx="10" fill="url(#pg-grad)" />
            {/* Pictogramme minimal type message */}
            <circle cx="13" cy="18" r="2" fill="white" />
            <circle cx="18" cy="18" r="2" fill="white" />
            <circle cx="23" cy="18" r="2" fill="white" />
          </svg>
        </div>
      </WsTestContextMenu>

      {/* Séparateur visuel */}
      <span className={styles.divider} />

      {/* Liste des programmes */}
      {!programs || programs.length <= 0 ? (
        <></>
      ) : (
        <ul className={styles.programList} role="list">
          {programs.map((prog) => {
            const programId = prog.id;
            const programLabel = getProgramLabel(prog);
            const isActive = programId === activeProgramId;

            return (
              <li
                key={programId}
                className={`${styles.programItem} ${isActive ? styles.programItemActive : ''}`}
                onClick={() => onSelectProgram?.(programId)}
              >
                <button
                  className={`${styles.programBtn} ${isActive ? styles.programBtnActive : ''}`}
                  title={programLabel}
                  aria-label={programLabel}
                  aria-current={isActive ? 'page' : undefined}
                  style={
                    prog.color
                      ? ({
                          '--program-color': prog.color,
                          color: contrastingTextColor(prog.color),
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  <span className={styles.programInitials}>{getProgramBadge(prog)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Bouton d'ajout (placeholder d'action) */}
      <button
        className={styles.addBtn}
        title="Ajouter un programme"
        aria-label="Ajouter un programme"
        onClick={onAddProgram}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </nav>
  );
};

export default ProgramMenu;
