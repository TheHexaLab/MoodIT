import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './CourseMenu.module.css';
import { MagnifyingGlass } from '../../assets/MagnifyingGlass.tsx';
import { Chevron } from '../../assets/Chevron.tsx';
import { Pencil } from '../../assets/Pencil.tsx';
import { type Program } from '../ProgramMenu/ProgramMenu';
import UserMenu, { type UserMenuUser } from '../UserMenu/UserMenu';
import CourseChannelList, {
  type ChannelRef,
  type ChannelTypeDefinition,
  type CourseChannel,
  isSameChannel,
} from '../CourseChannelList/CourseChannelList';
import { CourseSectionEditor } from './CourseSectionEditor.tsx';
import { CourseContextMenu } from './CourseContextMenu.tsx';
import { defaultLabels as dropdownLabels } from './labels.ts';
import { type ItemChange, type MaybePromise } from '../SectionEditorPopup/types.ts';
import { normalizeCourseChannelsFromSources } from '../CourseChannelList/courseChannelSources';
import { type Course } from '../../types/domain.ts';

// Entité ré-exportée depuis le modèle de domaine (source unique : src/types/domain.ts).
export type { Course };

// Ré-export du contrat « API + temps réel » : les consommateurs (Dashboard) et la
// façade socket importent ces types depuis CourseMenu.
export type {
  CourseChannelsSocket,
  FetchCoursesHandler,
  IncomingCourseHandlers,
} from './courseChannelsApi';

/** Bornes de largeur du panneau (px) et clé de persistance. */
const MIN_WIDTH = 176; // 11rem (= borne basse de la clamp responsive)
const MAX_WIDTH = 448; // 28rem
const DEFAULT_WIDTH = 224; // 14rem (repli quand la largeur rendue est illisible)
const WIDTH_STORAGE_KEY = 'courseMenu:width';

function clampWidth(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px));
}

/** Largeur persistée valide, ou null (→ largeur clamp par défaut). */
function readStoredWidth(): number | null {
  if (typeof localStorage === 'undefined') return null;
  const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : null;
}

interface CourseMenuProps {
  /** Programme actuellement sélectionné ; null si aucun. */
  activeProgram?: Program | null;
  /** Cours disponibles pour le programme actif. */
  courses?: Course[];
  /** Cours actuellement sélectionné dans la liste déroulante. */
  selectedCourseId?: number;
  /** Callback lors d'un changement de cours. */
  onSelectCourse?: (courseId: number) => void;
  /** Definition des types de canaux affiches dans la liste. */
  channelTypeDefinitions?: ChannelTypeDefinition[];
  /** Canal actuellement sélectionné (type + id). */
  selectedChannel?: ChannelRef;
  /** Callback lors d'un changement de canal. */
  onSelectChannel?: (channel: ChannelRef) => void;
  /**
   * Callback d'ouverture d'un canal (vue a implementer).
   * Distinct de "onSelectChannel" pour permettre une navigation indépendante.
   */
  onOpenChannel?: (channel: CourseChannel) => void;
  /**
   * Persiste une modification de section (ajout/renommage/suppression/réordre des
   * canaux de la section). Reçoit le cours et le type de section concernés.
   * Peut être async ; le popup attend sa résolution et annule en cas d'échec.
   * Si absent, l'icône d'édition des sections n'est pas rendue.
   */
  onSectionChange?: (
    courseId: number,
    sectionType: string,
    change: ItemChange
  ) => MaybePromise<unknown>;
  /**
   * L'utilisateur est-il administrateur ? Conditionne l'affichage des actions
   * d'édition : crayon par cours, option « ajouter un cours », crayons de section.
   */
  isAdmin?: boolean;
  /**
   * Chargement de la liste des cours en cours (API-ready). Affiche un état de
   * chargement à la place de la liste. Piloté par le parent (GET du programme).
   */
  loading?: boolean;
  /**
   * Erreur de chargement de la liste des cours (null = aucune). Affiche un état
   * d'erreur avec un bouton « Réessayer » (voir `onReloadCourses`).
   */
  loadError?: string | null;
  /** Relance le chargement des cours (bouton « Réessayer » de l'état d'erreur). */
  onReloadCourses?: () => void;
  /** Callback de l'option « ajouter un cours » (en bas du menu déroulant). */
  onAddCourse?: () => void;
  /** Callback du crayon d'édition d'un cours dans le menu déroulant. */
  onEditCourse?: (courseId: number) => void;
  /**
   * Ouvre la « Gestion MCP — Feedback du cours » (clic droit sur le sélecteur, admin).
   * Si absent, l'item correspondant du menu contextuel n'est pas affiché.
   */
  onOpenMcpManagement?: (courseId: number) => void;
  /**
   * « Quitter le cours » (clic droit sur le sélecteur, admin). Action destructive.
   * Si absent, l'item correspondant du menu contextuel n'est pas affiché.
   */
  onLeaveCourse?: (courseId: number) => void;
  /**
   * Utilisateur connecte affiche en bas du panneau.
   */
  currentUser?: UserMenuUser | null;
  /** Profil en cours de chargement : le UserMenu affiche un skeleton. */
  userLoading?: boolean;
  /** Ouvre le formulaire de modification du profil (menu du compte). */
  onEditProfile?: () => void;
  /** Déconnecte l'utilisateur (menu du compte). */
  onLogout?: () => void;
}

/**
 * Panneau lateral secondaire affichant les canaux du cours sélectionné.
 * Si le programme n'a aucun cours, un état vide est affiché.
 * Sinon, un sélecteur de cours puis les canaux groupes par type sont rendus.
 */
const CourseMenu: React.FC<CourseMenuProps> = ({
  activeProgram,
  courses = [],
  selectedCourseId,
  onSelectCourse,
  channelTypeDefinitions,
  selectedChannel,
  onSelectChannel,
  onOpenChannel,
  onSectionChange,
  isAdmin = false,
  loading = false,
  loadError = null,
  onReloadCourses,
  onAddCourse,
  onEditCourse,
  onOpenMcpManagement,
  onLeaveCourse,
  currentUser,
  userLoading = false,
  onEditProfile,
  onLogout,
}) => {
  /** Menu déroulant des cours ouvert ? */
  const [isCourseOpen, setIsCourseOpen] = useState(false);
  /** Recherche dans le menu déroulant des cours. */
  const [courseSearch, setCourseSearch] = useState('');
  /** Section en cours d'édition (popup ouvert), ou null. */
  const [editingSection, setEditingSection] = useState<ChannelTypeDefinition | null>(null);
  /** Largeur du panneau (px) ; null = largeur clamp par défaut (jamais redimensionné). */
  const [width, setWidth] = useState<number | null>(readStoredWidth);
  /** Drag en cours (handle de redimensionnement) ? */
  const [isResizing, setIsResizing] = useState(false);
  /** Position + largeur (viewport) de la liste déroulante portée ; null si fermée. */
  const [pickerPos, setPickerPos] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  /** Position du menu contextuel (clic droit sur le sélecteur) ; null si fermé. */
  const [ctxMenuPos, setCtxMenuPos] = useState<{ x: number; y: number } | null>(null);
  /** Conteneur du sélecteur de cours (pour le click-outside du menu). */
  const selectRef = useRef<HTMLDivElement | null>(null);
  /** Liste déroulante portée vers <body> (pour le click-outside). */
  const pickerRef = useRef<HTMLDivElement | null>(null);
  /** Racine du panneau (pour lire la largeur rendue au début d'un drag). */
  const navRef = useRef<HTMLElement | null>(null);
  /** État du drag : position et largeur de départ. */
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

  const courseOptions = courses.map((course) => ({
    id: course.id,
    code: formatCourseCode(course),
    label: formatCourseLabel(course),
    title: course.title?.trim() ?? '',
    channels: normalizeCourseChannelsFromSources({
      channels: course.channels,
      quizzes: course.quizzes,
      forums: course.forums,
    }),
  }));
  const selectedCourse =
    courseOptions.find((course) => course.id === selectedCourseId) ?? courseOptions[0] ?? null;
  const effectiveSelectedChannel = getEffectiveSelectedChannel(
    selectedCourse?.channels ?? [],
    selectedChannel
  );
  const hasCourses = courseOptions.length > 0;
  const emptySubtitle = activeProgram
    ? 'Ce programme ne contient encore aucun cours à afficher.'
    : 'Rejoins un programme pour voir tes cours, canaux et forums.';

  // Calcule la position de la liste déroulante (sous le sélecteur, largeur fixe 20rem).
  // En fixed + portail vers <body>, elle échappe au overflow:hidden de la sidebar.
  const computePickerPosition = useCallback(() => {
    const anchor = selectRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const margin = rootFontSize; // 1rem : marge avec le bord de l'écran (pas collé)
    const maxWidth = 20 * rootFontSize; // 20rem : largeur cible quand il y a la place
    const minWidth = 11 * rootFontSize; // borne basse (cohérente avec la sidebar)

    // On aligne le picker sur la GAUCHE du sélecteur et on l'étend vers la droite,
    // sans dépasser maxWidth ni le bord droit de l'écran. Sur mobile (sélecteur après
    // le rail), il reste ainsi sous le sélecteur au lieu d'être collé au bord droit.
    let left = rect.left;
    let width = Math.min(maxWidth, window.innerWidth - left - margin);

    // Cas limite : sélecteur trop proche du bord droit → on décale le picker à gauche.
    if (width < minWidth) {
      width = Math.min(maxWidth, window.innerWidth - 2 * margin);
      left = Math.max(margin, window.innerWidth - width - margin);
    }

    setPickerPos({ left, top: rect.bottom + 4, width });
  }, []);

  // Ferme le menu au clic extérieur (sélecteur ou liste portée) ;
  // recalcule la position au resize / scroll tant qu'il est ouvert.
  useEffect(() => {
    if (!isCourseOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (selectRef.current?.contains(target) || pickerRef.current?.contains(target)) return;
      setIsCourseOpen(false);
      setCourseSearch('');
    }
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', computePickerPosition);
    window.addEventListener('scroll', computePickerPosition, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', computePickerPosition);
      window.removeEventListener('scroll', computePickerPosition, true);
    };
  }, [isCourseOpen, computePickerPosition]);

  // Persiste (ou efface) la largeur choisie.
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (width == null) localStorage.removeItem(WIDTH_STORAGE_KEY);
    else localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  // Pendant le drag : curseur col-resize global + sélection de texte désactivée.
  useEffect(() => {
    if (!isResizing) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [isResizing]);

  // ── Redimensionnement (handle bord droit, façon Discord) ──
  function handleResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeStart.current = {
      x: event.clientX,
      width: navRef.current?.offsetWidth ?? width ?? DEFAULT_WIDTH,
    };
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const start = resizeStart.current;
    if (!start) return;
    setWidth(clampWidth(start.width + (event.clientX - start.x)));
  }

  function handleResizePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStart.current) return;
    resizeStart.current = null;
    setIsResizing(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  // Ajustement fin au clavier ; double-clic → retour à la largeur par défaut.
  function handleResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const base = navRef.current?.offsetWidth ?? width ?? DEFAULT_WIDTH;
    setWidth(clampWidth(base + (event.key === 'ArrowLeft' ? -16 : 16)));
  }

  function toggleCourseOpen() {
    setIsCourseOpen((prev) => {
      if (!prev) computePickerPosition();
      return !prev;
    });
    setCourseSearch('');
  }

  function closeCoursePicker() {
    setIsCourseOpen(false);
    setCourseSearch('');
  }

  function selectCourse(courseId: number) {
    onSelectCourse?.(courseId);
    closeCoursePicker();
  }

  function editCourse(courseId: number) {
    onEditCourse?.(courseId);
    closeCoursePicker();
  }

  function addCourse() {
    onAddCourse?.();
    closeCoursePicker();
  }

  // Actions admin du menu contextuel (modifier, gestion MCP) ; « quitter le cours »
  // reste accessible à TOUS. On n'ouvre le menu que s'il aura au moins un item.
  const hasAdminContextActions = isAdmin && (Boolean(onEditCourse) || Boolean(onOpenMcpManagement));
  const hasContextMenu = hasAdminContextActions || Boolean(onLeaveCourse);

  // Clic droit sur le sélecteur de cours → menu contextuel. Ancré sous le sélecteur
  // (comme le Figma), pas à la position de la souris. Si aucun item n'est applicable,
  // on laisse le menu natif du navigateur (pas de preventDefault).
  function handleCourseContextMenu(event: React.MouseEvent<HTMLButtonElement>) {
    if (!selectedCourse || !hasContextMenu) return;
    event.preventDefault();
    closeCoursePicker(); // ferme la liste déroulante si elle était ouverte
    const rect = event.currentTarget.getBoundingClientRect();
    setCtxMenuPos({ x: rect.left, y: rect.bottom + 4 });
  }

  /** Cours filtrés par la recherche (sur le code et le titre). */
  function filteredCourses() {
    const query = courseSearch.trim().toLowerCase();
    if (query === '') return courseOptions;
    return courseOptions.filter((course) =>
      `${course.code} ${course.title} ${course.label}`.toLowerCase().includes(query)
    );
  }

  return (
    <nav
      ref={navRef}
      className={styles.sidebar}
      aria-label="Cours"
      style={width != null ? ({ ['--cm-width']: `${width}px` } as React.CSSProperties) : undefined}
    >
      {/* En-tete : sélecteur de cours seulement si la liste est chargée sans erreur ;
          sinon (chargement / erreur / aucun cours) on affiche le nom du programme. */}
      <header className={styles.header}>
        {hasCourses && !loading && !loadError ? (
          <div className={styles.selectWrapper} ref={selectRef}>
            <button
              type="button"
              className={`${styles.courseSelect}${isCourseOpen ? ` ${styles.courseSelectOpen}` : ''}`}
              onClick={toggleCourseOpen}
              onContextMenu={handleCourseContextMenu}
              aria-haspopup="listbox"
              aria-expanded={isCourseOpen}
            >
              <span className={styles.courseSelectCode}>
                {selectedCourse?.code ?? dropdownLabels.selectFallback}
              </span>
              <Chevron
                className={`${styles.selectChevron}${isCourseOpen ? ` ${styles.selectChevronOpen}` : ''}`}
                width="1rem"
                height="1rem"
              />
            </button>

            {isCourseOpen &&
              pickerPos &&
              createPortal(
                <div
                  ref={pickerRef}
                  className={styles.coursePicker}
                  role="listbox"
                  style={{ left: pickerPos.left, top: pickerPos.top, width: pickerPos.width }}
                >
                <div className={styles.pickerSearch}>
                  <MagnifyingGlass width="1rem" height="1rem" />
                  <input
                    type="text"
                    placeholder={dropdownLabels.searchPlaceholder}
                    autoFocus
                    value={courseSearch}
                    onChange={(event) => setCourseSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setIsCourseOpen(false);
                    }}
                  />
                </div>
                <ul>
                  {filteredCourses().length === 0 ? (
                    <li className={styles.pickerEmpty}>{dropdownLabels.noResults}</li>
                  ) : (
                    filteredCourses().map((course) => (
                      <li
                        key={course.id}
                        className={course.id === selectedCourse?.id ? styles.pickerActive : undefined}
                      >
                        <button
                          type="button"
                          className={styles.pickerSelect}
                          onClick={() => selectCourse(course.id)}
                          role="option"
                          aria-selected={course.id === selectedCourse?.id}
                        >
                          <span className={styles.pickerCode}>{course.code}</span>
                          {course.title && (
                            <span className={styles.pickerTitle}>{course.title}</span>
                          )}
                        </button>
                        {isAdmin && onEditCourse && (
                          <button
                            type="button"
                            className={styles.pickerEdit}
                            onClick={() => editCourse(course.id)}
                            aria-label={dropdownLabels.editCourseAction(course.code)}
                            title={dropdownLabels.editCourseAction(course.code)}
                          >
                            <Pencil width="14" height="14" aria-hidden="true" />
                          </button>
                        )}
                      </li>
                    ))
                  )}
                </ul>

                {isAdmin && onAddCourse && (
                  <button type="button" className={styles.pickerAdd} onClick={addCourse}>
                    <span className={styles.pickerAddIcon} aria-hidden="true">
                      +
                    </span>
                    <span>{dropdownLabels.addCourse}</span>
                  </button>
                )}
                </div>,
                document.body
              )}
          </div>
        ) : (
          <span className={styles.headerTitle}>{activeProgram?.label ?? 'Accueil'}</span>
        )}
      </header>

      {/* Zone principale : chargement / erreur / état vide / canaux du cours */}
      <main className={styles.main}>
        {loadError ? (
          <div className={styles.emptyState} role="alert">
            <p className={styles.emptyTitle}>Chargement impossible</p>
            <p className={styles.emptySubtitle}>{loadError}</p>
            {onReloadCourses && (
              <button type="button" className={styles.retryButton} onClick={onReloadCourses}>
                Réessayer
              </button>
            )}
          </div>
        ) : loading ? (
          <div className={styles.loadingState} role="status" aria-live="polite">
            <span className={styles.loadingSpinner} aria-hidden="true" />
            <p className={styles.emptySubtitle}>Chargement des cours…</p>
          </div>
        ) : !hasCourses ? (
          <div className={styles.emptyState}>
            {/* Icone decorative */}

            <p className={styles.emptyTitle}>Aucun cours</p>
            <p className={styles.emptySubtitle}>{emptySubtitle}</p>
          </div>
        ) : (
          <CourseChannelList
            channels={selectedCourse?.channels ?? []}
            typeDefinitions={channelTypeDefinitions}
            selectedChannel={effectiveSelectedChannel}
            onSelectChannel={onSelectChannel}
            onOpenChannel={onOpenChannel}
            onEditSection={isAdmin && onSectionChange ? setEditingSection : undefined}
          />
        )}
      </main>

      {/* Panneau utilisateur */}
      <footer className={styles.userPanel}>
        <UserMenu
          user={currentUser}
          loading={userLoading}
          onEditProfile={onEditProfile}
          onLogout={onLogout}
        />
      </footer>

      {/* Poignée de redimensionnement (bord droit) */}
      <div
        className={`${styles.resizeHandle}${isResizing ? ` ${styles.resizeHandleActive}` : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionner le menu des cours"
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onDoubleClick={() => setWidth(null)}
        onKeyDown={handleResizeKeyDown}
      />

      {/* Menu contextuel du sélecteur de cours (clic droit). Actions admin (modifier,
          gestion MCP) réservées aux admins ; « quitter le cours » accessible à tous. */}
      {ctxMenuPos && selectedCourse && (
        <CourseContextMenu
          x={ctxMenuPos.x}
          y={ctxMenuPos.y}
          courseCode={selectedCourse.code}
          onEditCourse={
            isAdmin && onEditCourse
              ? () => {
                  onEditCourse(selectedCourse.id);
                  setCtxMenuPos(null);
                }
              : undefined
          }
          onOpenMcp={
            isAdmin && onOpenMcpManagement
              ? () => {
                  onOpenMcpManagement(selectedCourse.id);
                  setCtxMenuPos(null);
                }
              : undefined
          }
          onLeaveCourse={
            onLeaveCourse
              ? () => {
                  onLeaveCourse(selectedCourse.id);
                  setCtxMenuPos(null);
                }
              : undefined
          }
          onClose={() => setCtxMenuPos(null)}
        />
      )}

      {/* Popup d'édition d'une section (liste de canaux du type concerné) */}
      {editingSection && selectedCourse && (
        <CourseSectionEditor
          section={editingSection}
          channels={selectedCourse.channels}
          onClose={() => setEditingSection(null)}
          onChange={(change) => onSectionChange?.(selectedCourse.id, editingSection.type, change)}
        />
      )}
    </nav>
  );
};

/**
 * Retourne le libellé complet d'un cours.
 * Priorité: nom UI > "CODE · Titre" backend > titre backend.
 */
function formatCourseLabel(course: Course): string {
  if (course.name?.trim()) return course.name.trim();

  const title = course.title?.trim() ?? '';
  const code = course.code?.trim() ?? '';

  if (code && title) return `${code} · ${title}`;
  return title || code || 'Cours';
}

/**
 * Retourne le code affiché dans le sélecteur (on ne montre que le code).
 * Priorité: code backend > nom UI > titre backend.
 */
function formatCourseCode(course: Course): string {
  const code = course.code?.trim();
  if (code) return code;
  if (course.name?.trim()) return course.name.trim();
  return course.title?.trim() || 'Cours';
}

function getEffectiveSelectedChannel(
  channels: CourseChannel[],
  selectedChannel: ChannelRef | undefined
): ChannelRef | undefined {
  if (selectedChannel === undefined) return undefined;
  return channels.some((channel) => isSameChannel(channel, selectedChannel))
    ? selectedChannel
    : undefined;
}

export default CourseMenu;
