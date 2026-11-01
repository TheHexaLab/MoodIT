/** Pages du portail à venir : chacune a son URL (/home/<slug>) et, pour l'instant, un écran d'attente. */
export const PORTAL_PAGES = [
  { slug: 'horaire', label: 'Horaire', path: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
  { slug: 'bulletin', label: 'Bulletin', path: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6' },
  { slug: 'factures', label: 'Factures', path: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' },
  {
    slug: 'aide',
    label: "Centre d'aide",
    path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
  },
] as const;

export type PortalPage = (typeof PORTAL_PAGES)[number];

/** Page du portail décrite par un chemin ; undefined pour l'Accueil et les vues d'un cours. */
export function portalPageFromPath(pathname: string): PortalPage | undefined {
  return PORTAL_PAGES.find(({ slug }) => pathname.replace(/\/$/, '') === `/home/${slug}`);
}
