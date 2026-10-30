import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { Markdown } from './Markdown';

/**
 * Rendu Markdown maison — focalisé sur le support des équations LaTeX (KaTeX).
 * Les marques Markdown de base (titres, gras, listes…) sont couvertes indirectement
 * par QuestionCard/ForumView ; ici on verrouille le comportement mathématique.
 */

afterEach(cleanup);

describe('Markdown — équations LaTeX (KaTeX)', () => {
  it('rend une équation EN LIGNE $…$', () => {
    const { container } = render(<Markdown source="Voici $E = mc^2$ dans le texte." />);
    const inline = container.querySelector('[data-role="math-inline"]');
    expect(inline).not.toBeNull();
    // KaTeX a bien produit son balisage.
    expect(inline!.querySelector('.katex')).not.toBeNull();
  });

  it('rend une équation EN BLOC $$…$$ (mode display)', () => {
    const { container } = render(<Markdown source={'$$\n\\int_0^1 x^2\\,dx\n$$'} />);
    const block = container.querySelector('[data-role="math-block"]');
    expect(block).not.toBeNull();
    expect(block!.querySelector('.katex-display')).not.toBeNull();
  });

  it('accepte un bloc $$…$$ sur une seule ligne', () => {
    const { container } = render(<Markdown source={'$$a^2 + b^2 = c^2$$'} />);
    expect(container.querySelector('[data-role="math-block"] .katex-display')).not.toBeNull();
  });

  it('ne lève pas sur une équation invalide (throwOnError:false)', () => {
    const { container } = render(<Markdown source="Cassé : $\\frac{1}{$ suite" />);
    // Pas d'exception, et un nœud math est bien présent (KaTeX rend l'erreur en rouge).
    expect(container.querySelector('[data-role="math-inline"]')).not.toBeNull();
  });

  it('un dollar échappé \\$ reste littéral (pas de maths)', () => {
    const { container } = render(<Markdown source={'Prix : \\$5 et \\$10.'} />);
    expect(container.querySelector('[data-role="math-inline"]')).toBeNull();
    expect(container.textContent).toContain('$5');
    expect(container.textContent).toContain('$10');
  });

  it("n'interprète pas un montant « $5 pour 10 » comme des maths", () => {
    // Garde d'espace : « $5 … » (espace avant le 2e $) empêche le faux match.
    const { container } = render(<Markdown source="Ça coûte $5 pour 10 personnes $ho." />);
    expect(container.querySelector('[data-role="math-inline"]')).toBeNull();
  });

  it('laisse intactes les autres marques Markdown', () => {
    const { container } = render(<Markdown source="**gras** et $x_1$" />);
    expect(container.querySelector('strong')).not.toBeNull();
    expect(container.querySelector('[data-role="math-inline"]')).not.toBeNull();
  });
});

describe('Markdown — blocs', () => {
  it("décale les titres d'un niveau (# → h2) et plafonne à h6", () => {
    const { container } = render(<Markdown source={'# Un\n## Deux\n###### Six'} />);
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Un');
    expect(container.querySelector('h3')?.textContent).toBe('Deux');
    // ###### (6) + 1 = 7, plafonné à h6.
    expect(container.querySelector('h6')?.textContent).toBe('Six');
  });

  it('rend un filet horizontal pour ---, *** et ___', () => {
    const { container } = render(<Markdown source={'a\n\n---\n\n***\n\n___'} />);
    expect(container.querySelectorAll('hr')).toHaveLength(3);
  });

  it('agrège les lignes > consécutives dans une même citation (contenu rendu récursivement)', () => {
    const { container } = render(<Markdown source={'> **cité**\n> suite\n\nhors'} />);
    const quotes = container.querySelectorAll('blockquote');
    expect(quotes).toHaveLength(1);
    expect(quotes[0].querySelector('strong')?.textContent).toBe('cité');
    expect(quotes[0].textContent).toContain('suite');
    expect(quotes[0].textContent).not.toContain('hors');
  });

  it('rend une liste à puces (- et *) avec marques inline dans les items', () => {
    const { container } = render(<Markdown source={'- un\n* *deux*\n- `trois`'} />);
    const items = container.querySelectorAll('ul > li');
    expect(Array.from(items).map((li) => li.textContent)).toEqual(['un', 'deux', 'trois']);
    expect(items[1].querySelector('em')).not.toBeNull();
    expect(items[2].querySelector('code')?.textContent).toBe('trois');
  });

  it('rend une liste numérotée', () => {
    const { container } = render(<Markdown source={'1. premier\n2. second'} />);
    const items = container.querySelectorAll('ol > li');
    expect(Array.from(items).map((li) => li.textContent)).toEqual(['premier', 'second']);
  });

  it('agrège les lignes consécutives en un paragraphe et coupe sur un bloc spécial', () => {
    const { container } = render(<Markdown source={'ligne un\nligne deux\n- item'} />);
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].textContent).toBe('ligne un ligne deux');
    expect(container.querySelector('ul > li')?.textContent).toBe('item');
  });

  it('normalise les fins de ligne CRLF', () => {
    const { container } = render(<Markdown source={'# Titre\r\ntexte'} />);
    expect(container.querySelector('h2')?.textContent).toBe('Titre');
    expect(container.querySelector('p')?.textContent).toBe('texte');
  });

  it('agrège un bloc $$ multi-ligne dont la 1re ligne porte déjà du LaTeX', () => {
    const { container } = render(<Markdown source={'$$x +\ny = 1$$\napres'} />);
    expect(container.querySelectorAll('[data-role="math-block"]')).toHaveLength(1);
    // La ligne suivant la fence fermante redevient un paragraphe.
    expect(container.querySelector('p')?.textContent).toBe('apres');
  });

  it('un bloc $$ non fermé consomme le reste sans planter', () => {
    const { container } = render(<Markdown source={'$$\na = b'} />);
    expect(container.querySelectorAll('[data-role="math-block"]')).toHaveLength(1);
    expect(container.querySelector('p')).toBeNull();
  });
});

describe('Markdown — liens', () => {
  it('rend un lien https sûr, ouvert dans un nouvel onglet sans opener', () => {
    const { container } = render(<Markdown source="Voir [la **doc**](https://exemple.ca/a)." />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://exemple.ca/a');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    // Le libellé du lien accepte les marques inline.
    expect(a.querySelector('strong')?.textContent).toBe('doc');
  });

  it('accepte les liens relatifs, ancres et mailto', () => {
    const { container } = render(<Markdown source="[a](/cours/1) [b](#sec) [c](mailto:x@y.ca)" />);
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/cours/1',
      '#sec',
      'mailto:x@y.ca',
    ]);
  });

  it("n'émet aucun lien pour un scheme dangereux (javascript:)", () => {
    const { container } = render(<Markdown source="[clic](javascript:alert(1))" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[clic](javascript:alert(1))');
  });
});

describe('Markdown — blocs de code', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rend le code brut et la pastille de langage, sans parser le Markdown à l'intérieur", () => {
    const { container } = render(<Markdown source={'```py\nx = **1**\n```'} />);
    const block = container.querySelector('[data-role="code-block"]')!;
    expect(block.querySelector('[data-role="code-lang"]')?.textContent).toBe('py');
    expect(block.querySelector('pre')?.textContent).toBe('x = **1**');
    // Bloc défilable : atteignable au clavier.
    expect(block.querySelector('pre')?.getAttribute('tabindex')).toBe('0');
    expect(block.querySelector('strong')).toBeNull();
    // Alias py → python : Prism a tokenisé (plusieurs spans de jetons).
    expect(block.querySelectorAll('pre span').length).toBeGreaterThan(1);
  });

  it('sans langage : pas de pastille', () => {
    const { container } = render(<Markdown source={'```\nbrut\n```'} />);
    expect(container.querySelector('[data-role="code-lang"]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('brut');
  });

  it('une fence non fermée prend tout le reste comme code', () => {
    const { container } = render(<Markdown source={'```js\nconst a = 1;\n# pas un titre'} />);
    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('const a = 1;# pas un titre');
  });

  it('copier écrit le code dans le presse-papiers puis revient à « Copier » après 1,5 s', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { getByLabelText } = render(<Markdown source={'```c\nint a;\nint b;\n```'} />);
    await act(async () => {
      fireEvent.click(getByLabelText('Copier'));
    });
    expect(writeText).toHaveBeenCalledWith('int a;\nint b;');
    expect(getByLabelText('Copié').getAttribute('data-copied')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(getByLabelText('Copier').getAttribute('data-copied')).toBeNull();
  });

  it('presse-papiers refusé : aucune exception et le bouton reste « Copier »', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('refus'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { getByLabelText, queryByLabelText } = render(<Markdown source={'```\nx\n```'} />);
    await act(async () => {
      fireEvent.click(getByLabelText('Copier'));
    });
    expect(writeText).toHaveBeenCalledWith('x');
    expect(queryByLabelText('Copié')).toBeNull();
  });
});
