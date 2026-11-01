const STORAGE_KEY = 'portalSidebar:collapsed';

/** Choix mémorisé pour la barre de l'Accueil ; false si rien n'est mémorisé ou lisible. */
export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Mémorise le choix ; sans stockage disponible, il vaut seulement pour la session. */
export function storeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  } catch {
    /* stockage indisponible (navigation privée, données bloquées) */
  }
}

const WIDTH_STORAGE_KEY = 'portalSidebar:width';

/** Bornes de largeur de la barre (px) : barre réduite + largeurs extrêmes du panneau du cours. */
export const SIDEBAR_MIN_WIDTH = 248; // 15,5rem
export const SIDEBAR_MAX_WIDTH = 520; // 32,5rem
export const SIDEBAR_DEFAULT_WIDTH = 272; // 17rem, comme le CSS

/** Largeur mémorisée de la barre complète, ou null (largeur par défaut). */
export function readSidebarWidth(): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    const stored = Number(raw);
    return raw != null && stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH ? stored : null;
  } catch {
    return null;
  }
}

/** Mémorise la largeur (null : l'oublie) ; sans stockage disponible, elle vaut pour la session. */
export function storeSidebarWidth(width: number | null): void {
  try {
    if (width == null) localStorage.removeItem(WIDTH_STORAGE_KEY);
    else localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    /* stockage indisponible (navigation privée, données bloquées) */
  }
}
