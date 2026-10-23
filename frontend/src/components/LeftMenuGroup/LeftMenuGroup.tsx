import React, { useEffect, useState } from 'react';
import styles from './LeftMenuGroup.module.css';

interface LeftMenuGroupProps {
  /** Premier panneau (menu programmes). */
  programMenu: React.ReactNode;
  /** Second panneau (menu cours). */
  courseMenu: React.ReactNode;
  /** Titre affiche dans la barre mobile (absent : « Accueil »). */
  mobileTitle?: string;
  /**
   * Identifiant de l'élément ouvert (canal, forum, quiz). Quand il change vers un élément
   * défini, le tiroir mobile se referme. Absent : le titre mobile sert d'identifiant.
   */
  selectionKey?: string | number;
  /** Icône/préfixe du titre (ex. `<ChannelTypeIcon />`). */
  mobileTitlePrefix?: React.ReactNode;
  /** Initiale affichée dans l'avatar mobile (repli si aucun menu fourni). */
  mobileUserInitial?: string;
  /** Menu du compte rendu dans la barre mobile (avatar cliquable en haut à droite). */
  mobileUserMenu?: React.ReactNode;
}

/**
 * Regroupe les menus latéraux et gère leur mode responsive.
 * En petit écran, la barre latérale est remplacée par un bouton hamburger.
 */
export default function LeftMenuGroup({
  programMenu,
  courseMenu,
  mobileTitle,
  selectionKey,
  mobileTitlePrefix = '',
  mobileUserInitial = 'U',
  mobileUserMenu,
}: LeftMenuGroupProps): React.ReactElement {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Choisir un élément dans le tiroir le referme (sinon le contenu reste caché derrière ses
  // 90 vw). Seul un choix fait dans le tiroir compte : un clic dans le tiroir arme la
  // fermeture, et le prochain changement de sélection la déclenche. Un changement asynchrone
  // (restauration du dernier emplacement après rechargement) ne referme donc pas un tiroir
  // que l'utilisateur vient d'ouvrir. Ajustement pendant le rendu plutôt qu'un effet : pas
  // de rendu intermédiaire où le tiroir recouvre encore le nouvel élément. Retour à
  // l'accueil (aucun élément, ex. changement de programme) : le tiroir reste ouvert.
  const selection = selectionKey ?? mobileTitle;
  const [lastSelection, setLastSelection] = useState(selection);
  const [pickedInDrawer, setPickedInDrawer] = useState(false);
  if (selection !== lastSelection) {
    setLastSelection(selection);
    setPickedInDrawer(false);
    if (pickedInDrawer && selection !== undefined) setIsDrawerOpen(false);
  }

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
          <span role="title">{mobileTitle ?? 'Accueil'}</span>
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
        onClick={() => {
          if (isDrawerOpen) setPickedInDrawer(true);
        }}
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
