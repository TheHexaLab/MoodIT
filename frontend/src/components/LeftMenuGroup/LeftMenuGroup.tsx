import React, { useEffect, useRef, useState } from 'react';
import styles from './LeftMenuGroup.module.css';

interface LeftMenuGroupProps {
  /** Premier panneau (menu programmes). */
  programMenu: React.ReactNode;
  /** Second panneau (menu cours). */
  courseMenu: React.ReactNode;
  /** Titre affiche dans la barre mobile. */
  mobileTitle?: string;
  /** Icône/préfixe du titre (ex. `<ChannelTypeIcon />`). */
  mobileTitlePrefix?: React.ReactNode;
  /** Initiale affichée dans l'avatar mobile (repli si aucun menu fourni). */
  mobileUserInitial?: string;
  /** Menu du compte rendu dans la barre mobile (avatar cliquable en haut à droite). */
  mobileUserMenu?: React.ReactNode;
  /**
   * Ferme le tiroir mobile chaque fois que cette valeur change (hors montage initial).
   * Sert à replier le menu quand on ouvre un canal : sur mobile, la sélection navigue
   * vers le panneau principal, qu'il faut donc révéler.
   */
  collapseKey?: string | number;
}

/**
 * Regroupe les menus latéraux et gère leur mode responsive.
 * En petit écran, la barre latérale est remplacée par un bouton hamburger.
 */
export default function LeftMenuGroup({
  programMenu,
  courseMenu,
  mobileTitle = 'Accueil',
  mobileTitlePrefix = '',
  mobileUserInitial = 'U',
  mobileUserMenu,
  collapseKey,
}: LeftMenuGroupProps): React.ReactElement {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const isFirstCollapseRun = useRef(true);

  // Referme le tiroir quand `collapseKey` change (ex. ouverture d'un canal). On saute
  // le montage initial : refermer un tiroir déjà fermé est sans effet, mais l'intention
  // est de ne réagir qu'aux changements ultérieurs.
  useEffect(() => {
    if (isFirstCollapseRun.current) {
      isFirstCollapseRun.current = false;
      return;
    }
    setIsDrawerOpen(false);
  }, [collapseKey]);

  useEffect(() => {
    if (!isDrawerOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isDrawerOpen]);

  useEffect(() => {
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsDrawerOpen(false);
    }

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  return (
    <>
      <header className={styles.mobileTopbar}>
        <button
          type="button"
          className={`${styles.hamburger} ${isDrawerOpen ? styles.hamburgerHidden : ''}`}
          onClick={() => setIsDrawerOpen((prev) => !prev)}
          aria-label={isDrawerOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
          aria-expanded={isDrawerOpen}
          aria-controls="left-menu-drawer"
        >
          <span className={styles.hamburgerLine} />
          <span className={styles.hamburgerLine} />
          <span className={styles.hamburgerLine} />
        </button>

        <h2 className={styles.mobileTitle}>
          {mobileTitlePrefix && (
            <span role="prefix">{mobileTitlePrefix}</span>
          )}
          <span role="title">{mobileTitle}</span>
        </h2>

        {mobileUserMenu ?? (
          <span className={styles.mobileAvatar} aria-label="Utilisateur connecté">
            {mobileUserInitial}
          </span>
        )}
      </header>

      <aside
        id="left-menu-drawer"
        className={`${styles.sidebarShell} ${isDrawerOpen ? styles.sidebarShellOpen : ''}`}
        aria-label="Menus lateraux"
      >
        <div className={styles.sidebarMenus}>
          {programMenu}
          {courseMenu}
        </div>
      </aside>

      <button
        type="button"
        className={`${styles.backdrop} ${isDrawerOpen ? styles.backdropVisible : ''}`}
        onClick={() => setIsDrawerOpen(false)}
        aria-label="Fermer le menu"
      />
    </>
  );
}
