/**
 * Retourne le prefixe visuel associe au type de canal.
 */
export function getPrefixForType(type: string): string {
  switch (type) {
    case 'quiz':
      return '?';
    case 'forum':
      return '⮡ ';
    case 'text':
      return '#';
    default:
      return '#';
  }
}

