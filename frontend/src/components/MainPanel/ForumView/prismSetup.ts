import { Prism } from 'prism-react-renderer';

/**
 * Expose le Prism « vendu » par prism-react-renderer sur l'objet global, afin que
 * les grammaires `prismjs/components/prism-*` (importees dans prismLanguages.ts)
 * s'enregistrent dessus. Ce module DOIT etre evalue avant ces imports — voir
 * l'ordre des imports dans prismLanguages.ts.
 */
(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;

export { Prism };
