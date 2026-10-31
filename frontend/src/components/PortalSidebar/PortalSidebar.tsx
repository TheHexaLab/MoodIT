import React from 'react';
import { Link } from 'react-router-dom';
import styles from './PortalSidebar.module.css';
import ProgramMenu from '../ProgramMenu/ProgramMenu.tsx';
import { courseTileColor } from './courseTile.ts';
import { getProgramPermissions } from '../../helpers/permissions.ts';
import type { Course, Program } from '../../types/domain.ts';

const HOME_ICON = 'M3 11l9-8 9 8M5 9.5V21h14V9.5M10 21v-6h4v6';
const PLUS_ICON = 'M12 5v14M5 12h14';

/** Pages du portail à venir : présentes pour la maquette, sans action pour l'instant. */
const UPCOMING_PAGES = [
  { label: 'Horaire', path: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
  { label: 'Factures', path: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' },
  {
    label: "Centre d'aide",
    path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
  },
];

type ProgramActions = Pick<
  React.ComponentProps<typeof ProgramMenu>,
  | 'onAddCourseToProgram'
  | 'onEditProgram'
  | 'onManageRoles'
  | 'onDeleteProgram'
  | 'onJoinCourses'
  | 'onLeaveProgram'
>;

interface PortalSidebarProps {
  programs: Program[];
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
  /** Programmes dont les cours n'ont pas pu être chargés. */
  failedProgramIds?: number[];
  /** L'utilisateur est-il administrateur global ? (actions du menu contextuel des programmes) */
  isGlobalAdmin?: boolean;
  /** Actions d'un programme : son menu contextuel, et les boutons sous ses cours. */
  programActions?: ProgramActions;
  onOpenCourse: (programId: number, courseId: number) => void;
  /** Rejoindre un programme de son établissement. */
  onJoinProgram: () => void;
  /** Menu du compte, au pied de la barre. */
  userMenu: React.ReactNode;
  /** Version réduite : icônes et tuiles seulement. */
  collapsed?: boolean;
  /** Réduit ou déplie la barre. Absent : pas de bouton (mobile, où la barre reste un tiroir). */
  onToggleCollapsed?: () => void;
  /** Programme ouvert (-1 : aucun, on est sur l'Accueil). */
  activeProgramId?: number;
  /** Cours ouvert : mis en évidence dans la liste. */
  selectedCourseId?: number;
}

function NavIcon({ path }: { path: string }): React.ReactElement {
  return (
    <svg className={styles.navIcon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Tuile d'un cours : son sigle complet (trois lettres ne distingueraient pas INF201 d'INF330). */
function tileLabel(course: Course): string {
  return course.code?.trim() || (course.title ?? '').replace(/[^\p{L}]/gu, '').slice(0, 3).toUpperCase();
}

/** Nom complet d'un cours, pour l'infobulle et le lecteur d'écran de sa tuile. */
function courseFullName(course: Course): string {
  return [course.code?.trim(), course.title?.trim()].filter(Boolean).join(' · ') || 'Cours';
}

/**
 * Barre de gauche du portail, complète ou réduite : pages du portail, puis les cours de
 * l'utilisateur, tous programmes confondus. Un cours rattaché à plusieurs programmes n'apparaît
 * qu'une fois, sous le programme ouvert s'il en fait partie, sinon sous le premier.
 *
 * Les deux versions partagent la même structure, dans un conteneur de largeur fixe : la barre glisse
 * et le masque, de sorte que les icônes et les tuiles ne bougent pas à l'horizontale (voir le CSS).
 */
export default function PortalSidebar({
  programs,
  loading,
  loadError,
  onReload,
  failedProgramIds = [],
  isGlobalAdmin = false,
  programActions,
  onOpenCourse,
  onJoinProgram,
  userMenu,
  collapsed = false,
  onToggleCollapsed,
  activeProgramId = -1,
  selectedCourseId,
}: PortalSidebarProps): React.ReactElement {
  const isHome = activeProgramId < 0;

  // Calculé ici, pas pendant le rendu de ProgramMenu : un rendu doit rester pur (StrictMode rend
  // deux fois, et un second passage verrait tous les cours comme déjà affichés).
  const seenCourseIds = new Set<number>();
  const coursesByProgram = new Map<number, Course[]>();
  const programsActiveFirst = [...programs].sort(
    (a, b) => Number(b.id === activeProgramId) - Number(a.id === activeProgramId)
  );
  for (const program of programsActiveFirst) {
    coursesByProgram.set(
      program.id,
      (program.courses ?? []).filter((course) => {
        if (seenCourseIds.has(course.id)) return false;
        seenCourseIds.add(course.id);
        return true;
      })
    );
  }

  const pageLinks = (
    <nav className={styles.pages} aria-label="Portail">
      <Link
        to="/home"
        className={`${styles.navItem} ${isHome ? styles.navItemActive : ''}`}
        aria-current={isHome ? 'page' : undefined}
        aria-label={collapsed ? 'Accueil' : undefined}
        title={collapsed ? 'Accueil' : undefined}
      >
        <NavIcon path={HOME_ICON} />
        <span className={styles.label}>Accueil</span>
      </Link>
      {UPCOMING_PAGES.map(({ label, path }) => (
        <button
          key={label}
          type="button"
          className={styles.navItem}
          aria-disabled="true"
          aria-label={collapsed ? label : undefined}
          title={collapsed ? label : 'Bientôt disponible'}
        >
          <NavIcon path={path} />
          <span className={styles.label}>{label}</span>
        </button>
      ))}
    </nav>
  );

  const toggleButton = onToggleCollapsed && (
    <button
      type="button"
      className={`${styles.navItem} ${styles.join} ${styles.toggle}`}
      aria-label={collapsed ? 'Déplier le menu' : undefined}
      title={collapsed ? 'Déplier le menu' : undefined}
      onClick={onToggleCollapsed}
    >
      <NavIcon path={collapsed ? 'M6 7l5 5-5 5M13 7l5 5-5 5' : 'M18 7l-5 5 5 5M11 7l-5 5 5 5'} />
      <span className={styles.label}>Réduire le menu</span>
    </button>
  );

  // Le « + » de la version réduite vise le programme ouvert ou le seul programme. Avec plusieurs
  // programmes, il déplie la barre, où chaque programme a son propre « Rejoindre un cours ».
  const joinTarget = !isHome ? activeProgramId : programs.length === 1 ? programs[0].id : null;
  const handleCollapsedJoin = () => {
    if (programs.length === 0) onJoinProgram();
    else if (joinTarget != null) programActions?.onJoinCourses?.(joinTarget);
    else onToggleCollapsed?.();
  };

  return (
    <div className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}>
      <div className={styles.inner}>
      {pageLinks}

      <span className={styles.divider} />
      <h2 className={styles.heading}>Mes cours</h2>
      <div className={styles.courses}>
        <ProgramMenu
          programs={programs}
          loading={loading}
          loadError={loadError}
          onReload={onReload}
          isGlobalAdmin={isGlobalAdmin}
          namesHidden={collapsed}
          {...programActions}
          renderCourses={(program) => (
            <>
              {failedProgramIds.includes(program.id) && (
                <p className={`${styles.status} ${styles.expandedOnly}`}>Cours indisponibles pour l'instant.</p>
              )}
              {(coursesByProgram.get(program.id) ?? []).map((course) => {
                const isActive = course.id === selectedCourseId;
                return (
                  <button
                    key={course.id}
                    type="button"
                    className={`${styles.course} ${isActive ? styles.courseActive : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={collapsed ? courseFullName(course) : undefined}
                    title={collapsed ? courseFullName(course) : undefined}
                    onClick={() => onOpenCourse(program.id, course.id)}
                  >
                    <span
                      className={styles.tile}
                      style={{ background: courseTileColor(course.id) }}
                      aria-hidden="true"
                    >
                      {tileLabel(course)}
                    </span>
                    <span className={styles.courseText}>
                      <span className={styles.courseTitle}>{course.title}</span>
                      {course.code && <span className={styles.courseCode}>{course.code}</span>}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                className={`${styles.navItem} ${styles.join} ${styles.expandedOnly}`}
                aria-label={`Rejoindre un cours : ${program.name}`}
                onClick={() => programActions?.onJoinCourses?.(program.id)}
              >
                <NavIcon path={PLUS_ICON} />
                <span className={styles.label}>Rejoindre un cours</span>
              </button>
              {getProgramPermissions(program, isGlobalAdmin).canManageContent && (
                <button
                  type="button"
                  className={`${styles.navItem} ${styles.join} ${styles.expandedOnly}`}
                  aria-label={`Ajouter un cours : ${program.name}`}
                  onClick={() => programActions?.onAddCourseToProgram?.(program.id)}
                >
                  <NavIcon path={PLUS_ICON} />
                  <span className={styles.label}>Ajouter un cours</span>
                </button>
              )}
            </>
          )}
        />
        {/* Toujours offert sans programme, et sur mobile où le « + » du bandeau est masqué. */}
        {!loading && !loadError && (
          <button
            type="button"
            className={`${styles.navItem} ${styles.join} ${styles.expandedOnly} ${programs.length > 0 ? styles.mobileOnly : ''}`}
            onClick={onJoinProgram}
          >
            <NavIcon path={PLUS_ICON} />
            <span className={styles.label}>Rejoindre un programme</span>
          </button>
        )}
        {/* Le « + » unique de la version réduite. */}
        {!loading && !loadError && (
          <button
            type="button"
            className={`${styles.navItem} ${styles.join} ${styles.collapsedOnly}`}
            aria-label="Rejoindre un cours"
            title="Rejoindre un cours"
            onClick={handleCollapsedJoin}
          >
            <NavIcon path={PLUS_ICON} />
          </button>
        )}
      </div>

      {toggleButton}
      <div className={styles.footer}>{userMenu}</div>
      </div>
    </div>
  );
}
