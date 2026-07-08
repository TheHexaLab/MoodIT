import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ProgramMenu.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { Plus } from '../../assets/Plus.tsx';
import { Pencil } from '../../assets/Pencil.tsx';
import { Sliders } from '../../assets/Sliders.tsx';
import { LogIn } from '../../assets/LogIn.tsx';
import { LogOut } from '../../assets/LogOut.tsx';
import { TrashCan } from '../../assets/TrashCan.tsx';
import { type Program } from '../../types/domain.ts';
import { getProgramPermissions } from '../../helpers/permissions.ts';

// Entité Program ré-exportée depuis le modèle de domaine (source unique).
export type { Program };

// Ré-export du contrat « API + temps réel » : Dashboard et la façade socket
// importent ces types depuis ProgramMenu.
export type {
  FetchProgramsHandler,
  IncomingProgramHandlers,
  ProgramsSocket,
} from './programsApi';

interface ProgramMenuProps {
  /** Programmes assignes a l'utilisateur. */
  programs?: Program[];
  /** Programme actuellement selectionne. */
  activeProgramId?: number;
  /** Callback de selection d'un programme. */
  onSelectProgram?: (id: number) => void;
  /** Callback du bouton d'ajout (adhesion / creation de programme). */
  onAddProgram?: () => void;
  /**
   * Chargement de la liste des programmes en cours (API-ready). Affiche un spinner
   * à la place de la liste. Piloté par le parent (GET des programmes de l'utilisateur).
   */
  loading?: boolean;
  /**
   * Erreur de chargement de la liste (null = aucune). Affiche un bouton « Réessayer »
   * à la place de la liste (voir `onReload`).
   */
  loadError?: string | null;
  /** Relance le chargement de la liste (bouton de l'état d'erreur). */
  onReload?: () => void;
  /**
   * L'utilisateur est-il ADMINISTRATEUR GLOBAL (super-admin plateforme, User_Role) ?
   * Les autres actions d'administration sont dérivées PAR PROGRAMME du rôle de l'utilisateur
   * dans ce programme (Program.roleName, User_Program_Role) via getProgramPermissions.
   * « Quitter le programme » reste accessible à tous.
   */
  isGlobalAdmin?: boolean;
  /** Menu contextuel (clic droit) — ajouter un cours au programme (gestion contenu). */
  onAddCourseToProgram?: (programId: number) => void;
  /** Menu contextuel — modifier le programme (Administrateur programme / global). */
  onEditProgram?: (programId: number) => void;
  /** Menu contextuel — gerer les roles du programme (gestion contenu). */
  onManageRoles?: (programId: number) => void;
  /** Menu contextuel — supprimer le programme (super-admin GLOBAL uniquement). */
  onDeleteProgram?: (programId: number) => void;
  /** Menu contextuel — rejoindre des cours du programme (tous). */
  onJoinCourses?: (programId: number) => void;
  /** Menu contextuel — quitter le programme (tous). */
  onLeaveProgram?: (programId: number) => void;
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
  loading = false,
  loadError = null,
  onReload,
  isGlobalAdmin = false,
  onAddCourseToProgram,
  onEditProgram,
  onManageRoles,
  onDeleteProgram,
  onJoinCourses,
  onLeaveProgram,
}) => {
  /** Menu contextuel ouvert : programme cible + position (viewport), ou null. */
  const [contextMenu, setContextMenu] = useState<{
    programId: number;
    left: number;
    top: number;
  } | null>(null);

  // Ferme le menu contextuel au clic, à l'Échap, au scroll ou au redimensionnement.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  // Ouvre le menu à DROITE de la pastille du programme (pas à la position de la souris).
  function openContextMenu(event: React.MouseEvent<HTMLLIElement>, programId: number) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const gap = 8;
    // Estimation de hauteur (actions admin PAR PROGRAMME + « rejoindre » + « quitter ») pour
    // éviter le débordement bas.
    const target = programs.find((p) => p.id === programId);
    const perms = getProgramPermissions(target, isGlobalAdmin);
    const adminItemCount =
      (perms.canManageContent ? 1 : 0) + // ajouter un cours
      (perms.canEditProgram ? 1 : 0) + // modifier le programme
      (perms.canManageRoles ? 1 : 0) + // gérer les rôles
      (perms.canDeleteProgram && onDeleteProgram ? 1 : 0); // supprimer le programme
    const itemCount = adminItemCount + (onJoinCourses ? 1 : 0) + 1;
    const estimatedHeight = itemCount * 40 + 16;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - estimatedHeight - 8));
    setContextMenu({ programId, left: rect.right + gap, top });
  }

  /** Exécute une action du menu contextuel puis le referme. */
  function runContextAction(action?: (programId: number) => void) {
    if (contextMenu && action) action(contextMenu.programId);
    setContextMenu(null);
  }

  return (
    <nav className={styles.rail} aria-label="Programme">
      {/* Icône applicative (meme gabarit que le programme actif). */}
      <div className={styles.appIcon} aria-label="MoodIT">
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

      {/* Séparateur visuel */}
      <span className={styles.divider} />

      {/* Liste des programmes (ou état de chargement / d'erreur). */}
      {loadError ? (
        <button
          type="button"
          className={styles.railRetry}
          onClick={onReload}
          title={loadError}
          aria-label="Réessayer le chargement des programmes"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M12.5 6.5A5 5 0 1 0 13 9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <path
              d="M12.5 3v3.5H9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : loading ? (
        <span className={styles.railSpinnerWrap} role="status" aria-label="Chargement des programmes" aria-busy="true">
          <Spinner size={24} />
        </span>
      ) : !programs || programs.length <= 0 ? (
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
                onContextMenu={(event) => openContextMenu(event, programId)}
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

      {/* Menu contextuel (clic droit sur un programme). Porté vers <body> + position
          fixe : échappe au overflow du rail et au transform du tiroir mobile. */}
      {contextMenu &&
        (() => {
          // Permissions dérivées du rôle de l'utilisateur DANS ce programme précis.
          const target = programs.find((p) => p.id === contextMenu.programId);
          const perms = getProgramPermissions(target, isGlobalAdmin);
          const showAdminSection =
            perms.canManageContent ||
            perms.canEditProgram ||
            perms.canManageRoles ||
            (perms.canDeleteProgram && !!onDeleteProgram);

          return createPortal(
          <div
            className={styles.contextMenu}
            role="menu"
            style={{ top: contextMenu.top, left: contextMenu.left }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {showAdminSection && (
              <>
                {perms.canManageContent && (
                  <button
                    type="button"
                    className={styles.contextItem}
                    role="menuitem"
                    onClick={() => runContextAction(onAddCourseToProgram)}
                  >
                    <Plus className={styles.contextIcon} width="1rem" height="1rem" aria-hidden="true" />
                    Ajouter un cours
                  </button>
                )}
                {perms.canEditProgram && (
                  <button
                    type="button"
                    className={styles.contextItem}
                    role="menuitem"
                    onClick={() => runContextAction(onEditProgram)}
                  >
                    <Pencil className={styles.contextIcon} width="1rem" height="1rem" aria-hidden="true" />
                    Modifier le programme
                  </button>
                )}
                {perms.canManageRoles && (
                  <button
                    type="button"
                    className={styles.contextItem}
                    role="menuitem"
                    onClick={() => runContextAction(onManageRoles)}
                  >
                    <Sliders className={styles.contextIcon} width="1rem" height="1rem" aria-hidden="true" />
                    Gérer les rôles
                  </button>
                )}
                {perms.canDeleteProgram && onDeleteProgram && (
                  <button
                    type="button"
                    className={`${styles.contextItem} ${styles.contextItemDanger}`}
                    role="menuitem"
                    onClick={() => runContextAction(onDeleteProgram)}
                  >
                    <TrashCan className={styles.contextIcon} width="1rem" height="1rem" aria-hidden="true" />
                    Supprimer le programme
                  </button>
                )}
                <span className={styles.contextDivider} />
              </>
            )}
            {onJoinCourses && (
              <button
                type="button"
                className={styles.contextItem}
                role="menuitem"
                onClick={() => runContextAction(onJoinCourses)}
              >
                <LogIn className={styles.contextIcon} width="1rem" height="1rem" aria-hidden="true" />
                Rejoindre des cours
              </button>
            )}
            <button
              type="button"
              className={`${styles.contextItem} ${styles.contextItemDanger}`}
              role="menuitem"
              onClick={() => runContextAction(onLeaveProgram)}
            >
              <LogOut className={styles.contextIcon} width="1rem" height="1rem" aria-hidden="true" />
              Quitter le programme
            </button>
          </div>,
          document.body
          );
        })()}
    </nav>
  );
};

export default ProgramMenu;
