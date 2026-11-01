import React, { useRef } from 'react';
import { Link } from 'react-router-dom';
import styles from './PortalSidebar.module.css';
import ProgramMenu from '../ProgramMenu/ProgramMenu.tsx';
import { courseTileColor } from './courseTile.ts';
import { PORTAL_PAGES, type PortalPage } from './portalPages.ts';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './sidebarPreference.ts';
import { useResizeHandle } from '../../hooks/useResizeHandle.ts';
import { getProgramPermissions } from '../../helpers/permissions.ts';
import type { Course, Program } from '../../types/domain.ts';

const HOME_ICON = 'M3 11l9-8 9 8M5 9.5V21h14V9.5M10 21v-6h4v6';
const PLUS_ICON = 'M12 5v14M5 12h14';

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
  /** Menu complet d'ajout de programme, dans la barre. Mobile seulement : le bandeau y est masqué. */
  onAddProgram?: () => void;
  /** Menu du compte, au pied de la barre. */
  userMenu: React.ReactNode;
  /** Version réduite : icônes et tuiles seulement. */
  collapsed?: boolean;
  /** Réduit ou déplie la barre. Absent : pas de bouton (mobile, où la barre reste un tiroir). */
  onToggleCollapsed?: () => void;
  /** Bouton du cours ouvert : le focus y arrive quand le panneau du cours se réduit. */
  activeCourseRef?: React.Ref<HTMLButtonElement>;
  /** Largeur demandée pour la version complète (px) ; null = par défaut. */
  width?: number | null;
  /** Change la largeur. Absent : pas de poignée (mobile). */
  onWidthChange?: (width: number | null) => void;
  /** Page du portail ouverte (Horaire, Factures…). */
  activePage?: PortalPage;
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
  onAddProgram,
  userMenu,
  collapsed = false,
  onToggleCollapsed,
  activeCourseRef,
  width = null,
  onWidthChange,
  activePage,
  activeProgramId = -1,
  selectedCourseId,
}: PortalSidebarProps): React.ReactElement {
  const inCourse = activeProgramId >= 0;
  const isHome = !inCourse && !activePage;
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const { isResizing, handleProps: resizeHandleProps } = useResizeHandle({
    width,
    onChange: (next) => onWidthChange?.(next),
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    fallback: SIDEBAR_DEFAULT_WIDTH,
    getRenderedWidth: () => sidebarRef.current?.offsetWidth,
  });

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
      {PORTAL_PAGES.map((page) => {
        const isActive = !inCourse && page.slug === activePage?.slug;
        return (
          <Link
            key={page.slug}
            to={`/home/${page.slug}`}
            className={`${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
            aria-current={isActive ? 'page' : undefined}
            aria-label={collapsed ? page.label : undefined}
            title={collapsed ? page.label : undefined}
          >
            <NavIcon path={page.path} />
            <span className={styles.label}>{page.label}</span>
          </Link>
        );
      })}
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
  const joinTarget = inCourse ? activeProgramId : programs.length === 1 ? programs[0].id : null;
  const handleCollapsedJoin = () => {
    if (programs.length === 0) onJoinProgram();
    else if (joinTarget != null) programActions?.onJoinCourses?.(joinTarget);
    else onToggleCollapsed?.();
  };

  return (
    <div
      ref={sidebarRef}
      className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''} ${isResizing ? styles.sidebarResizing : ''}`}
    >
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
                    ref={isActive ? activeCourseRef : undefined}
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
        {!loading && !loadError && onAddProgram && (
          <button
            type="button"
            className={`${styles.navItem} ${styles.join} ${styles.expandedOnly}`}
            onClick={onAddProgram}
          >
            <NavIcon path={PLUS_ICON} />
            <span className={styles.label}>Ajouter un programme</span>
          </button>
        )}
        {!loading && !loadError && !onAddProgram && programs.length === 0 && (
          <button
            type="button"
            className={`${styles.navItem} ${styles.join} ${styles.expandedOnly}`}
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
      {onWidthChange && !collapsed && (
        <div
          className={`${styles.resizeHandle} ${isResizing ? styles.resizeHandleActive : ''}`}
          aria-label="Redimensionner le menu"
          {...resizeHandleProps}
        />
      )}
    </div>
  );
}
