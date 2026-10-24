import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { MarkdownEditor } from './MarkdownEditor';

/**
 * Éditeur Markdown : actions de la barre d'outils (sur la sélection du textarea),
 * menus titres / langages, aperçu, raccourcis clavier, compteur de limite et
 * auto-dimensionnement (préservation du scroll du feed).
 */

/** Rappel du ResizeObserver courant (pour simuler un changement de largeur). */
let resizeCallback: (() => void) | null = null;
class ResizeObserverStub {
  constructor(callback: () => void) {
    resizeCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

beforeEach(() => {
  resizeCallback = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type EditorProps = React.ComponentProps<typeof MarkdownEditor>;

/** Éditeur contrôlé : l'état local reflète chaque `onChange` (comme dans ForumView). */
function Controlled({
  initial = '',
  onChangeSpy,
  ...rest
}: Partial<EditorProps> & { initial?: string; onChangeSpy?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor
      {...rest}
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
    />
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText('Éditeur Markdown') as HTMLTextAreaElement;
}

/** Monte un éditeur contrôlé et sélectionne [start, end) dans le textarea. */
function renderWithSelection(initial: string, start: number, end = start) {
  const onChangeSpy = vi.fn();
  render(<Controlled initial={initial} onChangeSpy={onChangeSpy} autoFocus={false} />);
  textarea().setSelectionRange(start, end);
  return onChangeSpy;
}

describe('MarkdownEditor — barre d’outils (marques inline)', () => {
  it('Gras entoure la sélection de ** et la resélectionne', async () => {
    const onChange = renderWithSelection('abc def', 4, 7);
    fireEvent.click(screen.getByLabelText('Gras'));
    expect(onChange).toHaveBeenCalledWith('abc **def**');
    // Après la frame : la sélection porte de nouveau sur « def » (entre les marqueurs).
    await waitFor(() => {
      expect(textarea().selectionStart).toBe(6);
      expect(textarea().selectionEnd).toBe(9);
    });
    expect(document.activeElement).toBe(textarea());
  });

  it('Italique entoure de *', () => {
    const onChange = renderWithSelection('mot', 0, 3);
    fireEvent.click(screen.getByLabelText('Italique'));
    expect(onChange).toHaveBeenCalledWith('*mot*');
  });

  it('Code en ligne entoure de backticks', () => {
    const onChange = renderWithSelection('x = 1', 0, 5);
    fireEvent.click(screen.getByLabelText('Code en ligne'));
    expect(onChange).toHaveBeenCalledWith('`x = 1`');
  });

  it('Lien produit [sélection](url)', () => {
    const onChange = renderWithSelection('voir doc', 5, 8);
    fireEvent.click(screen.getByLabelText('Lien'));
    expect(onChange).toHaveBeenCalledWith('voir [doc](url)');
  });

  it('sans sélection, insère les marqueurs au curseur', () => {
    const onChange = renderWithSelection('ab', 1);
    fireEvent.click(screen.getByLabelText('Gras'));
    expect(onChange).toHaveBeenCalledWith('a****b');
  });
});

describe('MarkdownEditor — préfixes de ligne', () => {
  it('Liste à puces préfixe la LIGNE COURANTE (pas la première) et place le curseur après', async () => {
    const onChange = renderWithSelection('l1\nl2', 4);
    fireEvent.click(screen.getByLabelText('Liste à puces'));
    expect(onChange).toHaveBeenCalledWith('l1\n- l2');
    await waitFor(() => expect(textarea().selectionStart).toBe(6));
    expect(textarea().selectionEnd).toBe(6);
  });

  it('Liste numérotée préfixe de « 1. »', () => {
    const onChange = renderWithSelection('item', 2);
    fireEvent.click(screen.getByLabelText('Liste numérotée'));
    expect(onChange).toHaveBeenCalledWith('1. item');
  });

  it('Citation préfixe de « > »', () => {
    const onChange = renderWithSelection('a\nb\nc', 2);
    fireEvent.click(screen.getByLabelText('Citation'));
    expect(onChange).toHaveBeenCalledWith('a\n> b\nc');
  });
});

describe('MarkdownEditor — menus déroulants', () => {
  it('menu Titre : ouvre la liste des niveaux, insère le préfixe choisi puis se ferme', () => {
    const onChange = renderWithSelection('texte', 3);
    const trigger = screen.getByLabelText('Titre');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Niveau de titre' });
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual(
      ['Titre', 'Sous-titre', 'En-tête', 'Petite en-tête']
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sous-titre' }));
    expect(onChange).toHaveBeenCalledWith('## texte');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('menu Bloc de code : entoure la sélection d’une fence avec le langage choisi', () => {
    const onChange = renderWithSelection('print(1)', 0, 8);
    fireEvent.click(screen.getByLabelText('Bloc de code'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Python' }));
    expect(onChange).toHaveBeenCalledWith('```python\nprint(1)\n```');
  });

  it('menu Bloc de code : « Sans langage » produit une fence nue', () => {
    const onChange = renderWithSelection('x', 0, 1);
    fireEvent.click(screen.getByLabelText('Bloc de code'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sans langage' }));
    expect(onChange).toHaveBeenCalledWith('```\nx\n```');
  });

  it('le menu se ferme sur Échap et au clic extérieur, pas au clic intérieur', () => {
    renderWithSelection('', 0);
    const trigger = screen.getByLabelText('Titre');
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    // Clic DANS le menu : reste ouvert.
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeTruthy();
    // Autre touche : reste ouvert.
    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.getByRole('menu')).toBeTruthy();
    // Clic en dehors : se ferme.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('re-cliquer le bouton du menu le referme', () => {
    renderWithSelection('', 0);
    const trigger = screen.getByLabelText('Bloc de code');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Langage du bloc de code' })).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('un menu qui dépasse le bord droit du viewport est ancré à droite', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      right: window.innerWidth + 50,
    } as DOMRect);
    renderWithSelection('', 0);
    fireEvent.click(screen.getByLabelText('Titre'));
    const menu = screen.getByRole('menu') as HTMLElement;
    expect(menu.style.left).toBe('auto');
    expect(menu.style.right).toBe('0px');
  });

  it('un menu qui tient dans le viewport garde son ancrage par défaut', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      right: 10,
    } as DOMRect);
    renderWithSelection('', 0);
    fireEvent.click(screen.getByLabelText('Titre'));
    const menu = screen.getByRole('menu') as HTMLElement;
    expect(menu.style.left).toBe('');
    expect(menu.style.right).toBe('');
  });
});

describe('MarkdownEditor — aperçu', () => {
  it('bascule en aperçu : rend le Markdown, masque le textarea et désactive les outils', () => {
    render(<Controlled initial={'**fort**'} autoFocus={false} />);
    const previewBtn = screen.getByLabelText('Aperçu');
    fireEvent.click(previewBtn);
    expect(previewBtn.getAttribute('aria-pressed')).toBe('true');
    expect(previewBtn.getAttribute('title')).toBe('Modifier');
    expect(screen.queryByLabelText('Éditeur Markdown')).toBeNull();
    const preview = document.querySelector('[role="preview"]')!;
    expect(preview.querySelector('strong')?.textContent).toBe('fort');
    expect((screen.getByLabelText('Gras') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Titre') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[role="markdown-editor-preview"]')).not.toBeNull();

    // Retour à l'édition : le textarea revient avec le même contenu.
    fireEvent.click(previewBtn);
    expect(previewBtn.getAttribute('aria-pressed')).toBe('false');
    expect(textarea().value).toBe('**fort**');
    expect((screen.getByLabelText('Gras') as HTMLButtonElement).disabled).toBe(false);
  });

  it('aperçu d’un contenu vide (espaces) : message dédié', () => {
    render(<Controlled initial={'   '} autoFocus={false} />);
    fireEvent.click(screen.getByLabelText('Aperçu'));
    expect(screen.getByText('Rien à prévisualiser.')).toBeTruthy();
  });
});

describe('MarkdownEditor — clavier', () => {
  it('Ctrl+Entrée et Cmd+Entrée valident (onSubmit) ; Entrée seule non', () => {
    const onSubmit = vi.fn();
    render(<Controlled initial="x" onSubmit={onSubmit} autoFocus={false} />);
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    const notCancelled = fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true });
    expect(notCancelled).toBe(false); // preventDefault appelé
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('Échap annule (onCancel)', () => {
    const onCancel = vi.fn();
    render(<Controlled initial="x" onCancel={onCancel} autoFocus={false} />);
    expect(fireEvent.keyDown(textarea(), { key: 'Escape' })).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('sans onSubmit/onCancel (mode intégré) : les raccourcis ne sont pas interceptés', () => {
    render(<Controlled initial="x" embedded autoFocus={false} />);
    expect(fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(textarea(), { key: 'Escape' })).toBe(true);
  });

  it('Tab remplace la sélection par 4 espaces et place le curseur après', async () => {
    const onChange = renderWithSelection('abXYcd', 2, 4);
    expect(fireEvent.keyDown(textarea(), { key: 'Tab' })).toBe(false);
    expect(onChange).toHaveBeenCalledWith('ab    cd');
    await waitFor(() => expect(textarea().selectionStart).toBe(6));
  });

  it('Maj+Tab garde le comportement natif (pas d’indentation)', () => {
    const onChange = renderWithSelection('ab', 1);
    expect(fireEvent.keyDown(textarea(), { key: 'Tab', shiftKey: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('la saisie notifie onChange avec le texte brut', () => {
    const onChange = renderWithSelection('', 0);
    fireEvent.change(textarea(), { target: { value: 'nouveau' } });
    expect(onChange).toHaveBeenCalledWith('nouveau');
    expect(textarea().value).toBe('nouveau');
  });
});

describe('MarkdownEditor — actions, limite et état', () => {
  it('affiche le compteur, et le passe en dépassement (rouge, aria-invalid, envoi bloqué)', () => {
    render(<Controlled initial="abcd" maxLength={5} submitLabel="Envoyer" autoFocus={false} />);
    expect(screen.getByText('4 / 5')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(document.querySelector('[role="editor-status"]')!.hasAttribute('data-over')).toBe(false);

    fireEvent.change(textarea(), { target: { value: 'abcdef' } });
    expect(screen.getByText('6 / 5')).toBeTruthy();
    expect(document.querySelector('[role="editor-status"]')!.hasAttribute('data-over')).toBe(true);
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
    expect(submit.disabled).toBe(true);
  });

  it('sans maxLength : pas de compteur', () => {
    render(<Controlled initial="a" submitLabel="Envoyer" autoFocus={false} />);
    expect(document.querySelector('[role="char-count"]')).toBeNull();
  });

  it('contenu vide ou disableSubmit : bouton de validation désactivé', () => {
    const { rerender } = render(
      <MarkdownEditor value="  " onChange={() => {}} submitLabel="OK" autoFocus={false} />
    );
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <MarkdownEditor value="ok" onChange={() => {}} submitLabel="OK" disableSubmit autoFocus={false} />
    );
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('les boutons Annuler / valider appellent onCancel / onSubmit', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <Controlled
        initial="ok"
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitLabel="Publier"
        autoFocus={false}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Publier' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submitting : le bouton affiche un spinner à la place du libellé et se désactive', () => {
    render(<Controlled initial="ok" submitLabel="Publier" submitting autoFocus={false} />);
    expect(screen.queryByRole('button', { name: 'Publier' })).toBeNull();
    const buttons = document.querySelectorAll('[role="editor-actions"] button');
    const submit = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).not.toContain('Publier');
  });

  it('mode intégré : pas de barre d’actions, attribut data-embedded', () => {
    render(<Controlled initial="ok" embedded maxLength={10} autoFocus={false} />);
    expect(document.querySelector('[role="editor-actions"]')).toBeNull();
    expect(document.querySelector('[role="markdown-editor"]')!.hasAttribute('data-embedded')).toBe(
      true
    );
  });

  it('la prop labels surcharge les textes internes', () => {
    render(<Controlled initial="" labels={{ bold: 'Fort', cancel: 'Fermer' }} autoFocus={false} />);
    expect(screen.getByLabelText('Fort')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fermer' })).toBeTruthy();
    // Les autres textes gardent leurs défauts.
    expect(screen.getByLabelText('Italique')).toBeTruthy();
  });

  it('un clic dans l’éditeur ne remonte pas au parent', () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <Controlled initial="" autoFocus={false} />
      </div>
    );
    fireEvent.click(textarea());
    expect(parentClick).not.toHaveBeenCalled();
  });
});

describe('MarkdownEditor — auto-dimensionnement', () => {
  /** Stubbe la hauteur de contenu et la bordure verticale du textarea. */
  function stubTextareaMetrics(ta: HTMLTextAreaElement, scrollHeight: number) {
    Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  }

  it('dimensionne le textarea sur son contenu + bordure, et re-mesure sur changement de largeur', () => {
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const cs = realGetComputedStyle(el);
      if (el instanceof HTMLTextAreaElement) {
        return { ...cs, borderTopWidth: '1px', borderBottomWidth: '1px' } as CSSStyleDeclaration;
      }
      return cs;
    });
    const { rerender } = render(<MarkdownEditor value="a" onChange={() => {}} autoFocus={false} />);
    const ta = textarea();
    stubTextareaMetrics(ta, 40);
    rerender(<MarkdownEditor value="ab" onChange={() => {}} autoFocus={false} />);
    expect(ta.style.height).toBe('42px');

    // Largeur inchangée : pas de re-mesure.
    stubTextareaMetrics(ta, 80);
    act(() => resizeCallback?.());
    expect(ta.style.height).toBe('42px');
    // Largeur modifiée : re-mesure.
    Object.defineProperty(ta, 'clientWidth', { configurable: true, get: () => 300 });
    act(() => resizeCallback?.());
    expect(ta.style.height).toBe('82px');
  });

  it('re-mesure une fois les polices chargées', async () => {
    let resolveFonts: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const cs = realGetComputedStyle(el);
      if (el instanceof HTMLTextAreaElement) {
        return { ...cs, borderTopWidth: '0px', borderBottomWidth: '0px' } as CSSStyleDeclaration;
      }
      return cs;
    });
    try {
      render(<MarkdownEditor value="a" onChange={() => {}} autoFocus={false} />);
      const ta = textarea();
      stubTextareaMetrics(ta, 64);
      await act(async () => {
        resolveFonts();
        await ready;
      });
      expect(ta.style.height).toBe('64px');
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  describe('dans un feed défilant', () => {
    /** Monte l'éditeur dans un parent défilant stubbé ; renvoie le parent et le textarea. */
    function mountInFeed(rootRect: Partial<DOMRect>, taRect: Partial<DOMRect> = {}) {
      const realGetComputedStyle = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
        const cs = realGetComputedStyle(el);
        if ((el as HTMLElement).dataset?.feed !== undefined) {
          return { ...cs, overflowY: 'auto' } as CSSStyleDeclaration;
        }
        return { ...cs, borderTopWidth: '0px', borderBottomWidth: '0px' } as CSSStyleDeclaration;
      });
      const { rerender } = render(
        <div data-feed="">
          <MarkdownEditor value="a" onChange={() => {}} autoFocus={false} />
        </div>
      );
      const feed = document.querySelector('[data-feed]') as HTMLElement;
      Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => 1000 });
      Object.defineProperty(feed, 'clientHeight', { configurable: true, get: () => 100 });
      feed.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 }) as DOMRect;
      const root = document.querySelector('[role="markdown-editor"]') as HTMLElement;
      root.getBoundingClientRect = () => rootRect as DOMRect;
      const ta = textarea();
      ta.getBoundingClientRect = () => taRect as DOMRect;
      const update = (value: string) =>
        rerender(
          <div data-feed="">
            <MarkdownEditor value={value} onChange={() => {}} autoFocus={false} />
          </div>
        );
      return { feed, ta, update };
    }

    it('éditeur qui déborde en bas : défile du strict minimum (+ marge) pour le révéler', () => {
      const { feed, ta, update } = mountInFeed({ top: 60, bottom: 150, height: 90 });
      feed.scrollTop = 10;
      ta.focus();
      update('ab');
      // 150 - 100 + 8 = 58 de plus que la position d'origine.
      expect(feed.scrollTop).toBe(68);
    });

    it('éditeur au-dessus du haut du feed : remonte pour le révéler', () => {
      const { feed, ta, update } = mountInFeed({ top: -40, bottom: 10, height: 50 });
      feed.scrollTop = 100;
      ta.focus();
      update('ab');
      // 0 - (-40) + 8 = 48 de moins.
      expect(feed.scrollTop).toBe(52);
    });

    it('éditeur plus haut que le feed : suit la zone de saisie au lieu de l’éditeur complet', () => {
      const { feed, ta, update } = mountInFeed(
        { top: 0, bottom: 500, height: 500 },
        { top: 50, bottom: 120, height: 70 }
      );
      feed.scrollTop = 0;
      ta.focus();
      update('ab');
      // Cible = textarea : 120 - 100 + 8 = 28.
      expect(feed.scrollTop).toBe(28);
    });

    it('éditeur visible : la position de scroll du feed est préservée', () => {
      const { feed, ta, update } = mountInFeed({ top: 10, bottom: 90, height: 80 });
      feed.scrollTop = 33;
      ta.focus();
      update('ab');
      expect(feed.scrollTop).toBe(33);
    });

    it('champ non focalisé : restaure la position mais ne défile pas', () => {
      const { feed, update } = mountInFeed({ top: 60, bottom: 150, height: 90 });
      feed.scrollTop = 10;
      update('ab');
      expect(feed.scrollTop).toBe(10);
    });
  });
});
