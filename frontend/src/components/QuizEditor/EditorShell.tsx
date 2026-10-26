import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './QuizEditor.module.css';
import { Chevron } from '../../assets/Chevron';
import { Popup } from '../Popup/Popup';
import { PopupVariant } from '../Popup/popupVariant';
import { usePopupController } from '../Popup/popupController';

interface EditorShellProps {
  title: string;
  subtitle?: string;
  /** Bouton retour (chevron) à gauche du titre — pour les vues empilées. */
  onBack?: () => void;
  /** Fermeture (croix, Échap, clic sur le fond). */
  onClose: () => void;
  /**
   * Intercepte la fermeture (croix, Échap, clic sur le fond) AVANT l'animation : reçoit
   * `proceed`, la fermeture animée réelle. Permet au parent d'afficher une confirmation (perte de
   * données) et de n'appeler `proceed` qu'après validation.
   */
  onCloseGuard?: (proceed: () => void) => void;
  /** Largeur du panneau (défaut : celle de la variante `Editor`, 30rem). Animée au changement de vue. */
  width?: string;
  /**
   * Corps défilant : si le contenu dépasse le viewport, seul le corps défile
   * (header + pied figés, scrollbar confinée au corps). Sinon (défaut), le
   * panneau ne défile pas — on compte sur les listes internes (plafonnées).
   */
  scrollBody?: boolean;
  /**
   * Hauteur max du panneau en `vh`, appliquée UNIQUEMENT en desktop (au-delà du
   * breakpoint mobile). En deçà, on garde la limite « viewport − marge ». Utile
   * pour l'éditeur de question (corps défilant) : on borne à 60vh sur grand écran.
   */
  desktopMaxVh?: number;
  /**
   * Réinitialise le défilement du corps en haut quand cette clé change. La coquille
   * étant persistante d'une vue à l'autre, le corps conserverait sinon le `scrollTop`
   * de la vue précédente (ex. harnais ouvert déjà défilé en bas).
   */
  scrollResetKey?: string | number;
  /**
   * Échap ferme l'éditeur (défaut : oui). À désactiver dans une vue de saisie : la fermeture
   * ferait perdre le travail non enregistré, sans confirmation.
   */
  closeOnEscape?: boolean;
  /**
   * Opération en cours (ex. enregistrement du quiz) : aucune sortie possible tant qu'elle n'a
   * pas répondu. Le chevron et la croix sont désactivés, Échap et le clic sur le fond sont
   * ignorés. Sinon, quitter pendant l'enregistrement affichait « Modifications non
   * enregistrées » alors que l'enregistrement était en cours.
   */
  busy?: boolean;
  children: React.ReactNode;
}

/** Marge minimale entre le panneau et les bords du viewport (px). */
const VIEWPORT_MARGIN = 48;

/**
 * Emplacement du pied de page : `EditorShell` expose le nœud DOM du pied (rangée
 * fixe sous le corps défilant) ; les vues y rendent leur barre d'actions via
 * `EditorFooter` (portail). Ainsi la barre reste HORS de la zone défilante (la
 * scrollbar ne longe que le corps), tout en gardant son état dans la vue.
 */
const FooterSlotContext = createContext<HTMLElement | null>(null);

/** Rend ses enfants dans le pied fixe de la coquille (hors du corps défilant). */
export function EditorFooter({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement | null {
  const slot = useContext(FooterSlotContext);
  return slot ? createPortal(children, slot) : null;
}

/**
 * Coquille commune des popups de l'éditeur de quiz, bâtie sur `Popup` (variante `Editor`) :
 * voile, sémantique de dialogue, focus, Échap et animation de sortie viennent de la coquille
 * centrale. Ici : disposition en colonne header fixe / corps (défilant si `scrollBody`) / pied
 * fixe, et **animation de la taille** du panneau (largeur + hauteur) au changement de vue : la
 * hauteur naturelle (header + corps + pied) est mesurée (`ResizeObserver`) puis appliquée avec
 * une transition.
 */
export function EditorShell({
  title,
  subtitle,
  onBack,
  onClose,
  onCloseGuard,
  width,
  scrollBody = false,
  desktopMaxVh,
  scrollResetKey,
  closeOnEscape = true,
  busy = false,
  children,
}: EditorShellProps): React.ReactElement {
  const popup = usePopupController();

  // Hauteur animée : somme des trois rangées (header + corps + pied), bornée au
  // viewport. Le corps (`contentRef`) garde sa hauteur naturelle même borné, donc
  // la mesure ne dépend pas de la hauteur posée (pas de boucle).
  const headerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number>();
  // Le contenu dépasse-t-il le viewport ? On n'autorise le défilement (scrollbar)
  // QUE dans ce cas, et seulement en mode `scrollBody`.
  const [clamped, setClamped] = useState(false);
  // À l'OUVERTURE, on ne veut que le pop-in (comme les autres popups), pas la
  // transition de taille : on l'active au 1er frame suivant le montage.
  const [animateSize, setAnimateSize] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimateSize(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Changement de vue : on repart en haut du corps (sinon le scroll de la vue
  // précédente persiste, cf. `scrollResetKey`). Avant le paint pour éviter un saut.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [scrollResetKey]);

  useLayoutEffect(() => {
    const measure = () => {
      // Desktop : borne supplémentaire en vh si demandée (ex. 60vh pour la question).
      const isMobile = window.matchMedia('(max-width: 30rem)').matches;
      let max = window.innerHeight - VIEWPORT_MARGIN;
      if (desktopMaxVh && !isMobile) {
        max = Math.min(max, (window.innerHeight * desktopMaxVh) / 100);
      }
      // Le panneau est en box-sizing border-box : ses bordures (variante Editor) font partie
      // de la hauteur posée, sinon le bas du contenu est rogné.
      const panel = headerRef.current?.parentElement;
      const panelStyle = panel ? getComputedStyle(panel) : null;
      const borders = panelStyle
        ? (parseFloat(panelStyle.borderTopWidth) || 0) + (parseFloat(panelStyle.borderBottomWidth) || 0)
        : 0;
      const natural =
        (headerRef.current?.offsetHeight ?? 0) +
        (contentRef.current?.offsetHeight ?? 0) +
        (footerSlot?.offsetHeight ?? 0) +
        borders;
      setHeight(Math.min(natural, max));
      setClamped(natural > max);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (headerRef.current) ro.observe(headerRef.current);
    if (contentRef.current) ro.observe(contentRef.current);
    if (footerSlot) ro.observe(footerSlot);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [footerSlot, desktopMaxVh]);

  const panelStyle = {
    ...(width ? { ['--popup-width']: width } : {}),
    ...(height != null ? { height: `${height}px` } : {}),
    // Le panneau clippe aux coins arrondis ; seul le corps défile (cf. `scrollBody`).
    overflow: 'hidden',
    // Transition de taille désactivée tant que le pop-in d'ouverture joue.
    ...(animateSize ? {} : { transition: 'none' }),
  } as React.CSSProperties;

  return (
    <Popup
      variant={PopupVariant.Editor}
      label={title}
      onClose={onClose}
      controller={popup}
      closeOnEscape={closeOnEscape && !busy}
      closeOnBackdrop={!busy}
      closeGuard={onCloseGuard}
      panelClassName={styles.panel}
      panelStyle={panelStyle}
    >
      <header className={styles.header} ref={headerRef}>
        <div className={styles.headerTitle}>
          {onBack && (
            <button
              type="button"
              className={styles.backChevron}
              aria-label="Retour"
              disabled={busy}
              onClick={onBack}
            >
              <Chevron width={16} height={16} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          )}
          <div className={styles.headerText}>
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          aria-label="Fermer"
          disabled={busy}
          onClick={() => {
            const proceed = () => popup.requestClose(onClose);
            if (onCloseGuard) onCloseGuard(proceed);
            else proceed();
          }}
        >
          ✕
        </button>
      </header>

      <div
        className={styles.panelBody}
        ref={bodyRef}
        style={{ overflowY: scrollBody && clamped ? 'auto' : 'hidden' }}
      >
        <div className={styles.panelBodyInner} ref={contentRef}>
          <FooterSlotContext.Provider value={footerSlot}>{children}</FooterSlotContext.Provider>
        </div>
      </div>

      <div className={styles.panelFooter} ref={setFooterSlot} />
    </Popup>
  );
}
