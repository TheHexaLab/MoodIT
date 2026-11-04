import React, { useEffect, useRef, useState } from 'react';
import styles from './CourseMenu.module.css';
import { type Program } from '../ProgramMenu/ProgramMenu';
import { isAssignmentChannel } from '../CourseChannelList/channelTypeDefinitions.ts';
import CourseChannelList, {
  type ChannelRef,
  type ChannelTypeDefinition,
  type CourseChannel,
  isSameChannel,
} from '../CourseChannelList/CourseChannelList';
import { CourseSectionEditor } from './CourseSectionEditor.tsx';
import { Spinner } from '../Spinner/Spinner.tsx';
import { CourseContextMenu } from './CourseContextMenu.tsx';
import { defaultLabels as dropdownLabels } from './labels.ts';
import { type ItemChange, type MaybePromise } from '../SectionEditorPopup/types.ts';
import { normalizeCourseChannelsFromSources } from '../CourseChannelList/courseChannelSources';
import { type Course, type Quiz } from '../../types/domain.ts';
import { type QuizEditorHandlers } from '../QuizEditor/editorTypes.ts';
import { isContextMenuKey } from '../../hooks/useMenuKeyboard.ts';
import { useResizeHandle } from '../../hooks/useResizeHandle.ts';

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
const MIN_WIDTH = 176; // 11rem
const MAX_WIDTH = 448; // 28rem
const DEFAULT_WIDTH = 200; // 12,5rem, comme le CSS (repli quand la largeur rendue est illisible)
const WIDTH_STORAGE_KEY = 'courseMenu:width';

/** Largeur persistée valide, ou null (→ largeur par défaut). */
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
  /** Cours actuellement ouvert (par défaut, le premier). */
  selectedCourseId?: number;
  /** Affiche l'entrée « Devoirs » du cours (voir CourseChannelList). */
  assignments?: { count?: number };
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
  /** « Modifier le cours » (clic droit sur le titre, admin). */
  onEditCourse?: (courseId: number) => void;
  /**
   * Ouvre la « Gestion MCP — Feedback du cours » (clic droit sur le titre, admin).
   * Si absent, l'item correspondant du menu contextuel n'est pas affiché.
   */
  onOpenMcpManagement?: (courseId: number) => void;
  /**
   * « Quitter le cours » (clic droit sur le titre, admin). Action destructive.
   * Si absent, l'item correspondant du menu contextuel n'est pas affiché.
   */
  onLeaveCourse?: (courseId: number) => void;
  /**
   * « Supprimer le cours » (clic droit sur le titre, admin uniquement). Action
   * destructive : retire le cours pour tous. Absent → item du menu contextuel masqué.
   */
  onDeleteCourse?: (courseId: number) => void;
  /** Panneau réduit : il disparaît ; un clic sur un cours de la barre du portail le rouvre. */
  collapsed?: boolean;
  /** Réduit le panneau (bouton de l'en-tête). Absent : pas de bouton (mobile). */
  onCollapse?: () => void;
  /**
   * Handlers CRUD de l'éditeur de quiz (crayon de la section « quiz »). Fournit
   * notamment `onFetchQuiz` pour charger les questions à l'édition. Sans eux,
   * l'éditeur opère en mémoire (questions absentes si le cours n'en porte pas).
   */
  quizHandlers?: QuizEditorHandlers;
  /** Remonte la liste des quiz d'un cours après un changement de l'éditeur (sync sidebar). */
  onQuizzesChange?: (courseId: number, quizzes: Quiz[]) => void;
}

/**
 * Panneau lateral secondaire affichant les canaux du cours sélectionné.
 * Si le programme n'a aucun cours, un état vide est affiché.
 * Sinon, le titre du cours puis les canaux groupes par type sont rendus.
 */
const CourseMenu: React.FC<CourseMenuProps> = ({
  activeProgram,
  courses = [],
  selectedCourseId,
  assignments,
  channelTypeDefinitions,
  selectedChannel,
  onSelectChannel,
  onOpenChannel,
  onSectionChange,
  isAdmin = false,
  loading = false,
  loadError = null,
  onReloadCourses,
  onEditCourse,
  onOpenMcpManagement,
  onLeaveCourse,
  onDeleteCourse,
  collapsed = false,
  onCollapse,
  quizHandlers,
  onQuizzesChange,
}) => {
  /** Section en cours d'édition (popup ouvert), ou null. */
  const [editingSection, setEditingSection] = useState<ChannelTypeDefinition | null>(null);
  /** Largeur du panneau (px) ; null = largeur par défaut (jamais redimensionné). */
  const [width, setWidth] = useState<number | null>(readStoredWidth);
  /** Position du menu contextuel (clic droit sur le titre) ; null si fermé. */
  const [ctxMenuPos, setCtxMenuPos] = useState<{
    x: number;
    y: number;
    anchor: HTMLElement;
  } | null>(null);
  /** Racine du panneau (pour lire la largeur rendue au début d'un drag). */
  const navRef = useRef<HTMLElement | null>(null);
  const { isResizing, handleProps: resizeHandleProps } = useResizeHandle({
    width,
    onChange: setWidth,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: DEFAULT_WIDTH,
    getRenderedWidth: () => navRef.current?.offsetWidth,
  });

  // Long-press tactile sur le titre du cours (ouvre le menu contextuel sur mobile).
  const longPressTimer = useRef<number | null>(null);

  const courseOptions = courses.map((course) => ({
    id: course.id,
    code: formatCourseCode(course),
    title: course.title,
    channels: normalizeCourseChannelsFromSources({
      quizzes: course.quizzes,
      forums: course.forums,
    }),
    // Quiz d'origine (avec questions) : alimentent l'éditeur de quiz riche.
    quizzes: course.quizzes ?? [],
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

  // Persiste (ou efface) la largeur choisie.
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (width == null) localStorage.removeItem(WIDTH_STORAGE_KEY);
    else localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  // Actions admin du menu contextuel (modifier, gestion MCP) ; « quitter le cours »
  // reste accessible à TOUS. On n'ouvre le menu que s'il aura au moins un item.
  const hasAdminContextActions =
    isAdmin && (Boolean(onEditCourse) || Boolean(onOpenMcpManagement) || Boolean(onDeleteCourse));
  const hasContextMenu = hasAdminContextActions || Boolean(onLeaveCourse);

  // Ouvre le menu contextuel ANCRÉ sous le titre (comme le Figma), pas à la position du
  // pointeur. Partagé par le clic droit (desktop / long-press Android) et le long-press tactile.
  function openCourseContextMenu(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    setCtxMenuPos({ x: rect.left, y: rect.bottom + 4, anchor });
  }

  // Clic droit sur le titre du cours → menu contextuel. Si aucun item n'est applicable,
  // on laisse le menu natif du navigateur (pas de preventDefault).
  function handleCourseContextMenu(event: React.MouseEvent<HTMLButtonElement>) {
    if (!selectedCourse || !hasContextMenu) return;
    event.preventDefault();
    openCourseContextMenu(event.currentTarget);
  }

  // Touche Menu ou Maj+F10 sur le titre → même menu, sur tous les moteurs (seul Chromium
  // les convertit lui-même en `contextmenu`).
  function handleCourseSelectKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!selectedCourse || !hasContextMenu || !isContextMenuKey(event)) return;
    event.preventDefault();
    openCourseContextMenu(event.currentTarget);
  }

  // ── Long-press tactile → menu contextuel (parité iOS) ──────────────────────────────────
  // iOS Safari n'émet PAS l'évènement `contextmenu` au long-press (contrairement à Android
  // Chrome) : le menu « Feedback du cours / Quitter » y était donc inaccessible. On détecte
  // nous-mêmes un appui maintenu (~500 ms sans glissement) pour ouvrir le MÊME menu.
  const LONG_PRESS_MS = 500;

  function clearLongPress() {
    if (longPressTimer.current != null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function handleCourseTouchStart(event: React.TouchEvent<HTMLButtonElement>) {
    if (!selectedCourse || !hasContextMenu) return;
    const anchor = event.currentTarget; // capturé : l'évènement React est réutilisé après le timeout
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      openCourseContextMenu(anchor);
    }, LONG_PRESS_MS);
  }

  // Un glissement (l'utilisateur scrolle) ou la levée du doigt annule le long-press en cours.
  function cancelCourseLongPress() {
    clearLongPress();
  }

  // Nettoyage : ne jamais laisser un timer d'appui courir après le démontage.
  useEffect(() => clearLongPress, []);

  return (
    <nav
      ref={navRef}
      className={`${styles.sidebar}${collapsed ? ` ${styles.sidebarCollapsed}` : ''}${isResizing ? ` ${styles.sidebarResizing}` : ''}`}
      aria-label="Cours"
      style={width != null ? ({ ['--cm-width']: `${width}px` } as React.CSSProperties) : undefined}
    >
      {/* En-tete : titre du cours seulement si la liste est chargée sans erreur ;
          sinon (chargement / erreur / aucun cours) on affiche le nom du programme. */}
      <header className={styles.header}>
        {hasCourses && !loading && !loadError ? (
          <div className={styles.selectWrapper}>
            {/* Pas d'action au clic : le bouton ne porte que le menu contextuel du cours. */}
            <button
              type="button"
              className={`${styles.courseSelect}${selectedCourse?.title ? ` ${styles.courseSelectWithTitle}` : ''}`}
              onContextMenu={handleCourseContextMenu}
              onKeyDown={handleCourseSelectKeyDown}
              onTouchStart={handleCourseTouchStart}
              onTouchMove={cancelCourseLongPress}
              onTouchEnd={cancelCourseLongPress}
              onTouchCancel={cancelCourseLongPress}
              aria-haspopup={selectedCourse && hasContextMenu ? 'menu' : undefined}
              // Annonce le raccourci d'ouverture du menu contextuel (lecteurs d'écran).
              aria-keyshortcuts={selectedCourse && hasContextMenu ? 'Shift+F10' : undefined}
            >
              <span className={styles.courseSelectCode}>
                {selectedCourse?.code ?? dropdownLabels.selectFallback}
              </span>
            </button>
            {/* Repère visuel, hors du bouton : son nom accessible reste le code du cours. */}
            {selectedCourse?.title && (
              <span className={styles.courseSelectTitle} aria-hidden="true">
                {selectedCourse.title}
              </span>
            )}
          </div>
        ) : (
          <span className={styles.headerTitle}>{activeProgram?.label ?? 'Accueil'}</span>
        )}
        {onCollapse && (
          <button
            type="button"
            className={styles.collapseButton}
            aria-label="Réduire le panneau du cours"
            title="Réduire le panneau du cours"
            onClick={onCollapse}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M18 7l-5 5 5 5M11 7l-5 5 5 5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
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
          <div className={styles.loadingState} role="status" aria-live="polite" aria-busy="true">
            <Spinner size={24} />
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
            assignments={assignments}
          />
        )}
      </main>

      {/* Poignée de redimensionnement (bord droit) */}
      <div
        className={`${styles.resizeHandle}${isResizing ? ` ${styles.resizeHandleActive}` : ''}`}
        aria-label="Redimensionner le menu des cours"
        {...resizeHandleProps}
      />

      {/* Menu contextuel du titre du cours (clic droit). Actions admin (modifier,
          gestion MCP) réservées aux admins ; « quitter le cours » accessible à tous. */}
      {ctxMenuPos && selectedCourse && (
        <CourseContextMenu
          x={ctxMenuPos.x}
          y={ctxMenuPos.y}
          anchor={ctxMenuPos.anchor}
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
          onDeleteCourse={
            isAdmin && onDeleteCourse
              ? () => {
                  onDeleteCourse(selectedCourse.id);
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
          courseId={selectedCourse.id}
          quizzes={selectedCourse.quizzes}
          quizSubtitle={selectedCourse.code}
          quizHandlers={quizHandlers}
          onQuizzesChange={
            onQuizzesChange
              ? (quizzes) => onQuizzesChange(selectedCourse.id, quizzes)
              : undefined
          }
        />
      )}
    </nav>
  );
};

/**
 * Retourne le code affiché en titre (on ne montre que le code).
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
  // Les devoirs ne sont pas des canaux normalisés : leur entrée suit l'URL directement.
  if (isAssignmentChannel(selectedChannel.type)) return selectedChannel;
  return channels.some((channel) => isSameChannel(channel, selectedChannel))
    ? selectedChannel
    : undefined;
}

export default CourseMenu;
