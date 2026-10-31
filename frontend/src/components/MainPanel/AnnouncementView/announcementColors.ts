/** Palette des annonces : clés alignées sur ForumService.ANNOUNCEMENT_COLORS (backend). */
export const ANNOUNCEMENT_COLORS = [
  { key: 'blue', label: 'Bleu', hex: '#378add' },
  { key: 'red', label: 'Rouge', hex: '#e24b4a' },
  { key: 'orange', label: 'Orange', hex: '#ef9f27' },
  { key: 'green', label: 'Vert', hex: '#4f9a2a' },
  { key: 'purple', label: 'Violet', hex: '#7f77dd' },
  { key: 'pink', label: 'Rose', hex: '#d4537e' },
] as const;

export type AnnouncementColor = (typeof ANNOUNCEMENT_COLORS)[number]['key'];

export const DEFAULT_ANNOUNCEMENT_COLOR: AnnouncementColor = 'blue';

/** Teinte d'une clé de palette ; repli sur le bleu pour une clé inconnue. */
export function announcementHex(color: string | null | undefined): string {
  return (ANNOUNCEMENT_COLORS.find((c) => c.key === color) ?? ANNOUNCEMENT_COLORS[0]).hex;
}
