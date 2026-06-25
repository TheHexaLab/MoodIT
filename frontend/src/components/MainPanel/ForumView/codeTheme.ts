import { type PrismTheme } from 'prism-react-renderer';

/**
 * Thème de coloration syntaxique Prism partagé (rendu Markdown ET éditeur de code).
 * Les couleurs sont des variables CSS (définies dans index.css pour le clair ET le
 * sombre), donc le rendu suit le thème de l'app.
 */
export const codeTheme: PrismTheme = {
  plain: { color: 'var(--syntax-fg)', backgroundColor: 'transparent' },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: 'var(--syntax-comment)', fontStyle: 'italic' },
    },
    { types: ['punctuation'], style: { color: 'var(--syntax-punctuation)' } },
    {
      types: ['keyword', 'atrule', 'important', 'selector', 'rule'],
      style: { color: 'var(--syntax-keyword)' },
    },
    { types: ['tag', 'builtin', 'class-name'], style: { color: 'var(--syntax-class)' } },
    {
      types: ['string', 'char', 'attr-value', 'regex', 'url', 'inserted'],
      style: { color: 'var(--syntax-string)' },
    },
    {
      types: ['number', 'boolean', 'constant', 'symbol'],
      style: { color: 'var(--syntax-number)' },
    },
    { types: ['function'], style: { color: 'var(--syntax-function)' } },
    { types: ['operator', 'entity'], style: { color: 'var(--syntax-operator)' } },
    {
      types: ['variable', 'property', 'attr-name', 'parameter', 'deleted'],
      style: { color: 'var(--syntax-variable)' },
    },
  ],
};
