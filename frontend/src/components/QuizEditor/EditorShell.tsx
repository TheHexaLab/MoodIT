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

interface EditorShellProps {
  title: string;
  subtitle?: string;
  /** Bouton retour (chevron) à gauche du titre — pour les vues empilées. */
  onBack?: () => void;
  /** Fermeture (croix + clic sur le fond). */
  onClose: () => void;
  /** Largeur du panneau (défaut 30rem). Animée au changement de vue. */
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
 * Coquille commune des popups de l'éditeur, portée dans `document.body`
 * (`createPortal`) pour passer AU-DESSUS de tout et rester centrée même sous un
 * ancêtre transformé (tiroir mobile). Disposition en colonne : header fixe / corps
 * (défilant si `scrollBody`) / pied fixe. Le panneau **anime sa taille** (largeur +
 * hauteur) au changement de contenu : la hauteur naturelle (header + corps + pied)
 * est mesurée (`ResizeObserver`) puis appliquée avec une transition.
 */
export function EditorShell({
  title,
  subtitle,
  onBack,
  onClose,
  width,
  scrollBody = false,
  desktopMaxVh,
  scrollResetKey,
  children,
}: EditorShellProps): React.ReactElement {
  const [isClosing, setIsClosing] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  // Le clic de fond ne ferme que si le geste a COMMENCÉ sur le fond : sans ça, une sélection de
  // texte démarrée DANS le popup et relâchée dehors déclenche un « click » sur l'overlay (ancêtre
  // commun) et fermait le popup par erreur.
  const backdropMouseDown = useRef(false);

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
      const natural =
        (headerRef.current?.offsetHeight ?? 0) +
        (contentRef.current?.offsetHeight ?? 0) +
        (footerSlot?.offsetHeight ?? 0);
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

  function requestClose(action: () => void) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      action();
      return;
    }
    pending.current = action;
    setIsClosing(true);
  }

  function onAnimationEnd(e: React.AnimationEvent<HTMLDivElement>) {
    if (isClosing && e.target === e.currentTarget) {
      pending.current?.();
      pending.current = null;
    }
  }

  const overlay = (
    <div
      className={`${styles.overlay}${isClosing ? ` ${styles.closing}` : ''}`}
      onMouseDown={(e) => {
        backdropMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Ferme uniquement si le pointeur s'est ABAISSÉ ET relâché sur le fond (vrai clic de fond),
        // pas si une sélection démarrée dans le popup se termine ici.
        if (e.target === e.currentTarget && backdropMouseDown.current) requestClose(onClose);
        backdropMouseDown.current = false;
      }}
    >
      <div
        className={styles.panel}
        style={
          {
            ...(width ? { ['--panel-width']: width } : {}),
            ...(height != null ? { height: `${height}px` } : {}),
            // Transition de taille désactivée tant que le pop-in d'ouverture joue.
            ...(animateSize ? {} : { transition: 'none' }),
          } as React.CSSProperties
        }
        onAnimationEnd={onAnimationEnd}
      >
        <header className={styles.header} ref={headerRef}>
          <div className={styles.headerTitle}>
            {onBack && (
              <button
                type="button"
                className={styles.backChevron}
                aria-label="Retour"
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
            onClick={() => requestClose(onClose)}
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
      </div>
    </div>
  );

  return <Portal>{overlay}</Portal>;
}

/** Monte ses enfants dans `document.body` (au-dessus de tout, hors transformés). */
export function Portal({ children }: { children: React.ReactNode }): React.ReactPortal | null {
  const [host] = useState(() =>
    typeof document !== 'undefined' ? document.createElement('div') : null
  );
  // `useLayoutEffect` (et non `useEffect`) : l'hôte est attaché AVANT le paint, et
  // avant la mesure de hauteur du parent (effets enfant → parent). Sinon le contenu
  // serait détaché à la mesure → hauteur 0 puis correction animée à l'ouverture.
  useLayoutEffect(() => {
    if (!host) return;
    document.body.appendChild(host);
    return () => {
      document.body.removeChild(host);
    };
  }, [host]);
  return host ? createPortal(children, host) : null;
}
