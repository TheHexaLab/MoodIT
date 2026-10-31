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
