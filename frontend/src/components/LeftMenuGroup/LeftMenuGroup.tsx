import React, { useEffect, useState } from 'react';
import styles from './LeftMenuGroup.module.css';

interface LeftMenuGroupProps {
  /** Premier panneau (menu programmes). */
  programMenu: React.ReactNode;
  /** Second panneau (menu cours). */
  courseMenu: React.ReactNode;
  /** Titre affiche dans la barre mobile. */
  mobileTitle?: string;
  /** Initiale affichée dans l'avatar mobile. */
  mobileUserInitial?: string;
}

/**
 * Regroupe les menus latéraux et gère leur mode responsive.
 * En petit écran, la barre latérale est remplacée par un bouton hamburger.
 */
export default function LeftMenuGroup({
  programMenu,
  courseMenu,
  mobileTitle = 'Accueil',
  mobileUserInitial = 'U',
}: LeftMenuGroupProps): React.ReactElement {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

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

        <h2 className={styles.mobileTitle}>{mobileTitle}</h2>

        <span className={styles.mobileAvatar} aria-label="Utilisateur connecté">
          {mobileUserInitial}
        </span>
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
