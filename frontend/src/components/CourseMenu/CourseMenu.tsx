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
   * Utilisateur connecte affiche en bas du panneau.
   */
  currentUser?: UserMenuUser | null;
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
  currentUser,
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
  /** Position fixe (viewport) de la liste déroulante portée ; null si fermée. */
  const [pickerPos, setPickerPos] = useState<{ left: number; top: number } | null>(null);
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
    ? 'Ce programme ne contient encore aucun cours a afficher.'
    : 'Rejoins un programme pour voir tes cours, canaux et forums.';

  // Calcule la position de la liste déroulante (sous le sélecteur, largeur fixe 20rem).
  // En fixed + portail vers <body>, elle échappe au overflow:hidden de la sidebar.
  const computePickerPosition = useCallback(() => {
    const anchor = selectRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const pickerWidth = 20 * rootFontSize;
    const gap = 4;
    const maxLeft = window.innerWidth - pickerWidth - gap;
    const left = Math.max(gap, Math.min(rect.left, maxLeft));
    setPickerPos({ left, top: rect.bottom + gap });
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
              aria-haspopup="listbox"
              aria-expanded={isCourseOpen}
            >
              <span className={styles.courseSelectCode}>{selectedCourse?.code ?? 'Cours'}</span>
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
                  style={{ left: pickerPos.left, top: pickerPos.top }}
                >
                <div className={styles.pickerSearch}>
                  <MagnifyingGlass width="1rem" height="1rem" />
                  <input
                    type="text"
                    placeholder="Rechercher un cours…"
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
                    <li className={styles.pickerEmpty}>Aucun résultat</li>
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
                            aria-label={`Modifier le cours ${course.code}`}
                            title={`Modifier le cours ${course.code}`}
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
                    <span>Ajouter un cours</span>
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
        <UserMenu user={currentUser} onEditProfile={onEditProfile} onLogout={onLogout} />
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
