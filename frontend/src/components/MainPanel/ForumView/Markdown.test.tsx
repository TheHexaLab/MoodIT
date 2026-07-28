import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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
    const inline = container.querySelector('[role="math-inline"]');
    expect(inline).not.toBeNull();
    // KaTeX a bien produit son balisage.
    expect(inline!.querySelector('.katex')).not.toBeNull();
  });

  it('rend une équation EN BLOC $$…$$ (mode display)', () => {
    const { container } = render(<Markdown source={'$$\n\\int_0^1 x^2\\,dx\n$$'} />);
    const block = container.querySelector('[role="math-block"]');
    expect(block).not.toBeNull();
    expect(block!.querySelector('.katex-display')).not.toBeNull();
  });

  it('accepte un bloc $$…$$ sur une seule ligne', () => {
    const { container } = render(<Markdown source={'$$a^2 + b^2 = c^2$$'} />);
    expect(container.querySelector('[role="math-block"] .katex-display')).not.toBeNull();
  });

  it('ne lève pas sur une équation invalide (throwOnError:false)', () => {
    const { container } = render(<Markdown source="Cassé : $\\frac{1}{$ suite" />);
    // Pas d'exception, et un nœud math est bien présent (KaTeX rend l'erreur en rouge).
    expect(container.querySelector('[role="math-inline"]')).not.toBeNull();
  });

  it('un dollar échappé \\$ reste littéral (pas de maths)', () => {
    const { container } = render(<Markdown source={'Prix : \\$5 et \\$10.'} />);
    expect(container.querySelector('[role="math-inline"]')).toBeNull();
    expect(container.textContent).toContain('$5');
    expect(container.textContent).toContain('$10');
  });

  it("n'interprète pas un montant « $5 pour 10 » comme des maths", () => {
    // Garde d'espace : « $5 … » (espace avant le 2e $) empêche le faux match.
    const { container } = render(<Markdown source="Ça coûte $5 pour 10 personnes $ho." />);
    expect(container.querySelector('[role="math-inline"]')).toBeNull();
  });

  it('laisse intactes les autres marques Markdown', () => {
    const { container } = render(<Markdown source="**gras** et $x_1$" />);
    expect(container.querySelector('strong')).not.toBeNull();
    expect(container.querySelector('[role="math-inline"]')).not.toBeNull();
  });
});
