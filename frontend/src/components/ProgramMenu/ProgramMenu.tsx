import React from 'react';
import styles from './ProgramMenu.module.css';

export interface Program {
  /** Identifiant UI optionnel. */
  id?: string;
  /** Identifiant provenant directement de la BD/API. */
  id_program?: string | number;
  /** Libelle UI deja formate. */
  label?: string;
  /** Nom du programme provenant du backend. */
  name?: string;
  /** Cohorte du programme (ex. 201-NYC-05) provenant du backend. */
  cohort?: string;
  logoUrl?: string;
}

interface ProgramMenuProps {
  /** Programmes assignes a l'utilisateur. */
  programs?: Program[];
  /** Programme actuellement selectionne. */
  activeProgramId?: string;
  /** Callback de selection d'un programme. */
  onSelectProgram?: (id: string) => void;
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

/** Retourne un identifiant stable pour un programme, peu importe sa source. */
function getProgramId(program: Program): string {
  return String(program.id ?? program.id_program ?? '');
}

/**
 * Retourne le texte a afficher pour un programme.
 * Priorite: label UI > cohorte backend > nom backend.
 */
function getProgramLabel(program: Program): string {
  const displayLabel = program.label ?? program.cohort ?? program.name ?? '';
  return displayLabel.trim();
}

const ProgramMenu: React.FC<ProgramMenuProps> = ({
  programs = [],
  activeProgramId,
  onSelectProgram,
  onAddProgram,
}) => {
  return (
    <nav className={styles.rail} aria-label="Programme">
      {/* Icône applicative (meme gabarit que le programme actif) */}
      <div className={styles.appIcon} aria-label="MoodIT">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
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

      {/* Séparateur visuel */}
      <span className={styles.divider} />

      {/* Liste des programmes */}
      <ul className={styles.programList} role="list">
        {programs.map((prog) => {
          const programId = getProgramId(prog);
          const programLabel = getProgramLabel(prog);
          const isActive = programId === activeProgramId;

          return (
            <li key={programId} className={styles.programItem}>
              {isActive && <span className={styles.activePill} aria-hidden="true" />}
              <button
                className={`${styles.programBtn} ${isActive ? styles.programBtnActive : ''}`}
                title={programLabel}
                aria-label={programLabel}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onSelectProgram?.(programId)}
              >
                {prog.logoUrl ? (
                  <img src={prog.logoUrl} alt={programLabel} className={styles.programLogo} />
                ) : (
                  <span className={styles.programInitials}>{getInitials(programLabel)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* Bouton d'ajout (placeholder d'action) */}
      <button
        className={styles.addBtn}
        title="Ajouter un programme"
        aria-label="Ajouter un programme"
        onClick={onAddProgram}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </nav>
  );
};

export default ProgramMenu;
