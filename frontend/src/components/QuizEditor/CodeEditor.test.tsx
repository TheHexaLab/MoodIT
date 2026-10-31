import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { CodeEditor } from './CodeEditor';
import {
  EXECUTION_BUSY_MESSAGE,
  ExecutionBusyError,
  type RunResult,
} from '../MainPanel/QuizView/quizAttempt';

// jsdom ne fournit pas ResizeObserver (utilisé par l'auto-dimensionnement de l'éditeur).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

afterEach(cleanup);

/** Récupère le textarea de l'éditeur (unique dans le rendu). */
function getTextarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

function makeRunResult(over: Partial<RunResult> = {}): RunResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    compileOutput: null,
    timedOut: false,
    ...over,
  };
}

describe('CodeEditor', () => {
  it('affiche la valeur fournie dans le textarea', () => {
    render(<CodeEditor value="print(42)" onChange={() => {}} ariaLabel="code" />);
    expect(getTextarea().value).toBe('print(42)');
  });

  it('notifie onChange à la saisie', () => {
    const onChange = vi.fn();
    render(<CodeEditor value="" onChange={onChange} ariaLabel="code" />);
    fireEvent.change(getTextarea(), { target: { value: 'x = 1' } });
    expect(onChange).toHaveBeenCalledWith('x = 1');
  });

  it('Tab insère 4 espaces (onChange) et empêche le comportement par défaut', () => {
    const onChange = vi.fn();
    render(<CodeEditor value="ab" onChange={onChange} ariaLabel="code" />);
    const ta = getTextarea();
    // curseur au début (start=end=0)
    ta.setSelectionRange(0, 0);
    const prevented = !fireEvent.keyDown(ta, { key: 'Tab' });
    // 4 espaces insérés au début.
    expect(onChange).toHaveBeenCalledWith('    ab');
    // preventDefault appelé → fireEvent renvoie false.
    expect(prevented).toBe(true);
  });

  it('affiche une étiquette de langage quand `language` est fourni', () => {
    render(<CodeEditor value="" onChange={() => {}} language="Python" ariaLabel="code" />);
    expect(screen.getByText('Python')).toBeTruthy();
  });

  it('en lecture seule, le textarea est readOnly et aucune logique Tab ne modifie la valeur', () => {
    const onChange = vi.fn();
    render(<CodeEditor value="ab" onChange={onChange} readOnly ariaLabel="code" />);
    const ta = getTextarea();
    expect(ta.readOnly).toBe(true);
    ta.setSelectionRange(0, 0);
    fireEvent.keyDown(ta, { key: 'Tab' });
    // Handler onKeyDown désactivé en lecture seule → pas d'insertion d'espaces.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("affiche le bouton d'exécution quand onRun est fourni et l'appelle au clic", async () => {
    const onRun = vi.fn().mockResolvedValue(makeRunResult({ stdout: 'hello' }));
    render(
      <CodeEditor value="print('hello')" onChange={() => {}} onRun={onRun} runLabel="Exécuter" ariaLabel="code" />
    );
    const runBtn = screen.getByRole('button', { name: 'Exécuter' });
    fireEvent.click(runBtn);
    expect(onRun).toHaveBeenCalledWith("print('hello')");
    // La sortie s'affiche dans la console intégrée.
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy());
  });

  it("n'affiche pas de bouton d'exécution sans onRun", () => {
    render(<CodeEditor value="" onChange={() => {}} language="Python" ariaLabel="code" />);
    expect(screen.queryByRole('button', { name: 'Exécuter' })).toBeNull();
  });

  it("n'affiche pas le bouton d'exécution en lecture seule même avec onRun", () => {
    const onRun = vi.fn();
    render(<CodeEditor value="" onChange={() => {}} onRun={onRun} readOnly ariaLabel="code" />);
    expect(screen.queryByRole('button', { name: 'Exécuter' })).toBeNull();
  });

  it("affiche un message d'erreur si onRun rejette", async () => {
    const onRun = vi.fn().mockRejectedValue(new Error('boom'));
    render(<CodeEditor value="x" onChange={() => {}} onRun={onRun} ariaLabel="code" />);
    fireEvent.click(screen.getByRole('button', { name: 'Exécuter' }));
    await waitFor(() =>
      expect(screen.getByText(/Exécution impossible pour le moment/)).toBeTruthy()
    );
  });

  it('affiche le message « trop d’exécutions » si le service refuse faute de place (429)', async () => {
    const onRun = vi.fn().mockRejectedValue(new ExecutionBusyError());
    render(<CodeEditor value="x" onChange={() => {}} onRun={onRun} ariaLabel="code" />);
    fireEvent.click(screen.getByRole('button', { name: 'Exécuter' }));
    expect(await screen.findByText(EXECUTION_BUSY_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(/Exécution impossible pour le moment/)).toBeNull();
  });
});

// ───────────────────────── Édition au clavier (état réel) ─────────────────────────

/**
 * File des `requestAnimationFrame` : l'éditeur repositionne le curseur dans un rAF, APRÈS
 * le re-rendu de la nouvelle valeur. On vide la file à la main une fois le rendu fait.
 */
let rafQueue: FrameRequestCallback[] = [];
function flushRaf() {
  act(() => {
    const q = rafQueue;
    rafQueue = [];
    q.forEach((cb) => cb(0));
  });
}

/** Éditeur contrôlé avec un vrai état (la valeur suit onChange), pour vérifier valeur + curseur. */
function Stateful({ initial, spy }: { initial: string; spy: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <CodeEditor
      value={value}
      onChange={(v) => {
        setValue(v);
        spy(v);
      }}
      ariaLabel="code"
    />
  );
}

function renderStateful(initial: string) {
  const spy = vi.fn();
  render(<Stateful initial={initial} spy={spy} />);
  return { spy, ta: getTextarea() };
}

/** Place la sélection puis presse une touche ; renvoie true si le défaut a été empêché. */
function press(
  ta: HTMLTextAreaElement,
  key: string,
  [start, end]: [number, number],
  init: KeyboardEventInit = {}
): boolean {
  ta.setSelectionRange(start, end);
  return !fireEvent.keyDown(ta, { key, ...init });
}

function caret(ta: HTMLTextAreaElement): [number, number] {
  return [ta.selectionStart, ta.selectionEnd];
}

describe('CodeEditor — édition au clavier', () => {
  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Tab remplace la sélection par 4 espaces et place le curseur après', () => {
    const { ta, spy } = renderStateful('abcd');
    expect(press(ta, 'Tab', [1, 3])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('a    d');
    flushRaf();
    expect(caret(ta)).toEqual([5, 5]);
  });

  it('Maj+Tab n’indente pas (comportement natif conservé)', () => {
    const { ta, spy } = renderStateful('ab');
    expect(press(ta, 'Tab', [0, 0], { shiftKey: true })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('Retour arrière entre une paire vide supprime les deux côtés', () => {
    const { ta, spy } = renderStateful('f()');
    expect(press(ta, 'Backspace', [2, 2])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('f');
    flushRaf();
    expect(caret(ta)).toEqual([1, 1]);
  });

  it('Retour arrière entre des guillemets vides supprime la paire', () => {
    const { ta, spy } = renderStateful('""');
    expect(press(ta, 'Backspace', [1, 1])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('');
  });

  it('Retour arrière dans l’indentation retire un niveau jusqu’au taquet précédent', () => {
    // 6 espaces → retour au taquet de 4. Curseur en FIN de texte : régression où la
    // détection de « paire vide » (undefined === undefined) ne retirait qu'un espace.
    const { ta, spy } = renderStateful('x\n      ');
    expect(press(ta, 'Backspace', [8, 8])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('x\n    ');
    flushRaf();
    expect(caret(ta)).toEqual([6, 6]);
  });

  it('Retour arrière sur un taquet plein retire 4 espaces', () => {
    const { ta, spy } = renderStateful('        ');
    expect(press(ta, 'Backspace', [8, 8])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('    ');
  });

  it('Retour arrière après du texte ou sur une sélection : comportement natif', () => {
    const { ta, spy } = renderStateful('  ab');
    expect(press(ta, 'Backspace', [4, 4])).toBe(false);
    expect(press(ta, 'Backspace', [0, 2])).toBe(false);
    // Début de texte : rien avant le curseur.
    expect(press(ta, 'Backspace', [0, 0])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('Entrée conserve l’indentation de la ligne courante', () => {
    const { ta, spy } = renderStateful('    x = 1');
    expect(press(ta, 'Enter', [9, 9])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('    x = 1\n    ');
    flushRaf();
    expect(caret(ta)).toEqual([14, 14]);
  });

  it('Entrée après un ouvreur de bloc (« : » Python) ajoute un niveau', () => {
    const { ta, spy } = renderStateful('def f():  ');
    expect(press(ta, 'Enter', [10, 10])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('def f():  \n    ');
  });

  it('Entrée entre des accolades développe le bloc sur trois lignes', () => {
    const { ta, spy } = renderStateful('  if {}');
    expect(press(ta, 'Enter', [6, 6])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('  if {\n      \n  }');
    flushRaf();
    // Curseur sur la ligne du milieu, indenté d'un niveau de plus.
    expect(caret(ta)).toEqual([13, 13]);
  });

  it('Entrée pendant une composition (IME) est laissée au navigateur', () => {
    const { ta, spy } = renderStateful('ab');
    expect(press(ta, 'Enter', [2, 2], { isComposing: true })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('retaper un fermeur juste avant lui-même le franchit sans doublon', () => {
    const { ta, spy } = renderStateful('f()');
    expect(press(ta, ')', [2, 2])).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    flushRaf();
    expect(caret(ta)).toEqual([3, 3]);
  });

  it('taper un ouvreur insère aussi le fermeur, curseur au milieu', () => {
    const { ta, spy } = renderStateful('f');
    expect(press(ta, '(', [1, 1])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('f()');
    flushRaf();
    expect(caret(ta)).toEqual([2, 2]);
  });

  it('auto-fermeture devant un séparateur (espace, ponctuation)', () => {
    const { ta, spy } = renderStateful('x ;');
    expect(press(ta, '[', [2, 2])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('x [];');
  });

  it('un ouvreur avec sélection entoure la sélection et la conserve', () => {
    const { ta, spy } = renderStateful('abc');
    expect(press(ta, '"', [0, 3])).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('"abc"');
    flushRaf();
    expect(caret(ta)).toEqual([1, 4]);
  });

  it('pas d’auto-fermeture en plein mot (guillemet après une lettre)', () => {
    const { ta, spy } = renderStateful('l');
    expect(press(ta, "'", [1, 1])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('pas d’auto-fermeture juste avant un caractère collé', () => {
    const { ta, spy } = renderStateful('x');
    expect(press(ta, '(', [0, 0])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('raccourcis avec ⌘ (metaKey) : ni auto-fermeture ni franchissement', () => {
    const { ta, spy } = renderStateful('()');
    expect(press(ta, '(', [0, 0], { metaKey: true })).toBe(false);
    expect(press(ta, ')', [1, 1], { metaKey: true })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('une lettre ordinaire n’est pas interceptée', () => {
    const { ta, spy } = renderStateful('');
    expect(press(ta, 'a', [0, 0])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('en lecture seule, Entrée et les ouvreurs ne modifient rien', () => {
    const onChange = vi.fn();
    render(<CodeEditor value="{}" onChange={onChange} readOnly ariaLabel="code" />);
    const ta = getTextarea();
    expect(press(ta, 'Enter', [1, 1])).toBe(false);
    expect(press(ta, '(', [2, 2])).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ───────────────────────── Rendu : gouttière, coloration ─────────────────────────

describe('CodeEditor — gouttière et coloration', () => {
  function gutter(container: HTMLElement): string {
    return (container.querySelector('[class*="gutter"]') as HTMLElement).textContent ?? '';
  }

  it('numérote uniquement les lignes réelles', () => {
    const { container, rerender } = render(<CodeEditor value={'a\nb\nc'} onChange={() => {}} />);
    expect(gutter(container)).toBe('1\n2\n3');
    rerender(<CodeEditor value="" onChange={() => {}} />);
    expect(gutter(container)).toBe('1');
  });

  it('placeholder et nombre de lignes minimal transmis au textarea', () => {
    render(<CodeEditor value="" onChange={() => {}} placeholder="Ton code" minRows={7} ariaLabel="code" />);
    expect(getTextarea().placeholder).toBe('Ton code');
    expect(getTextarea().rows).toBe(7);
  });

  /** Textes des jetons Prism d'un type donné (ex. « keyword »). */
  function tokens(container: HTMLElement, type: string): string[] {
    return [...container.querySelectorAll(`pre span.token.${type}`)].map((s) => s.textContent ?? '');
  }

  it('colore selon la grammaire du langage (Python)', () => {
    const { container } = render(<CodeEditor value="def f(): return 1" onChange={() => {}} language="Python" />);
    expect(tokens(container, 'keyword')).toEqual(['def', 'return']);
  });

  it('résout les alias de grammaire : C++ → cpp, C# → csharp, HTML → markup', () => {
    const cpp = render(<CodeEditor value="class A {};" onChange={() => {}} language="C++" />);
    expect(tokens(cpp.container, 'keyword')).toContain('class');
    cpp.unmount();
    const cs = render(<CodeEditor value="namespace N {}" onChange={() => {}} language="C#" />);
    expect(tokens(cs.container, 'keyword')).toContain('namespace');
    cs.unmount();
    const html = render(<CodeEditor value="<b>x</b>" onChange={() => {}} language="HTML" />);
    expect(tokens(html.container, 'tag').length).toBeGreaterThan(0);
  });

  it('sans langage : texte brut, ni étiquette ni coloration', () => {
    const { container } = render(<CodeEditor value="def f(): pass" onChange={() => {}} />);
    expect(container.querySelector('pre span.token.keyword')).toBeNull();
    expect(container.querySelector('[class*="langLabel"]')).toBeNull();
  });

  it('l’étiquette de langage reste visible en lecture seule', () => {
    render(<CodeEditor value="" onChange={() => {}} language="SQL" readOnly />);
    expect(screen.getByText('SQL')).toBeTruthy();
  });
});

// ───────────────────────── Console d'exécution ─────────────────────────

describe('CodeEditor — console d’exécution', () => {
  function renderRun(onRun: (code: string) => Promise<RunResult> | RunResult) {
    const { container } = render(
      <CodeEditor value="code" onChange={() => {}} onRun={onRun} runLabel="Lancer" ariaLabel="code" />
    );
    return { container, runBtn: screen.getByRole('button', { name: 'Lancer' }) as HTMLButtonElement };
  }

  it('pendant l’exécution : bouton désactivé, console ouverte sans sortie ; pas de double lancement', async () => {
    let resolve!: (r: RunResult) => void;
    const onRun = vi.fn(() => new Promise<RunResult>((r) => (resolve = r)));
    const { runBtn } = renderRun(onRun);
    fireEvent.click(runBtn);
    await waitFor(() => expect(runBtn.disabled).toBe(true));
    expect(screen.getByText('Console')).toBeTruthy();
    fireEvent.click(runBtn);
    expect(onRun).toHaveBeenCalledTimes(1);
    resolve(makeRunResult({ stdout: 'fini' }));
    expect(await screen.findByText('fini')).toBeTruthy();
    expect(runBtn.disabled).toBe(false);
  });

  it('accepte un résultat synchrone', async () => {
    const { runBtn } = renderRun(() => makeRunResult({ stdout: 'sync' }));
    fireEvent.click(runBtn);
    expect(await screen.findByText('sync')).toBeTruthy();
  });

  it('stdout + stderr : la trace est précédée du libellé « Erreurs »', async () => {
    const { runBtn } = renderRun(() =>
      makeRunResult({ stdout: 'avant', stderr: 'Traceback…', exitCode: 1 })
    );
    fireEvent.click(runBtn);
    expect(await screen.findByText('Traceback…')).toBeTruthy();
    expect(screen.getByText('avant')).toBeTruthy();
    expect(screen.getByText('Erreurs')).toBeTruthy();
  });

  it('stderr seul : pas de libellé « Erreurs »', async () => {
    const { runBtn } = renderRun(() => makeRunResult({ stderr: 'boom', exitCode: 1 }));
    fireEvent.click(runBtn);
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.queryByText('Erreurs')).toBeNull();
  });

  it('sortie de compilation affichée sous « Compilation »', async () => {
    const { runBtn } = renderRun(() => makeRunResult({ compileOutput: 'error: x', exitCode: 1 }));
    fireEvent.click(runBtn);
    expect(await screen.findByText('error: x')).toBeTruthy();
    expect(screen.getByText('Compilation')).toBeTruthy();
    expect(screen.queryByText('(aucune sortie)')).toBeNull();
  });

  it('aucune sortie → « (aucune sortie) »', async () => {
    const { runBtn } = renderRun(() => makeRunResult());
    fireEvent.click(runBtn);
    expect(await screen.findByText('(aucune sortie)')).toBeTruthy();
  });

  it('dépassement de temps → statut explicite', async () => {
    const { runBtn } = renderRun(() => makeRunResult({ timedOut: true, signal: 'SIGKILL', exitCode: null }));
    fireEvent.click(runBtn);
    expect(await screen.findByText('Interrompu (dépassement de temps ou de mémoire)')).toBeTruthy();
    expect(screen.queryByText('(aucune sortie)')).toBeNull();
  });

  it('« Fermer la console » masque la console', async () => {
    const { runBtn } = renderRun(() => makeRunResult({ stdout: 'out' }));
    fireEvent.click(runBtn);
    await screen.findByText('out');
    fireEvent.click(screen.getByRole('button', { name: 'Fermer la console' }));
    expect(screen.queryByText('Console')).toBeNull();
    expect(screen.queryByText('out')).toBeNull();
  });

  it('une nouvelle exécution réussie efface l’erreur précédente', async () => {
    const onRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('réseau'))
      .mockResolvedValueOnce(makeRunResult({ stdout: 'ok' }));
    const { runBtn } = renderRun(onRun);
    fireEvent.click(runBtn);
    expect(await screen.findByText(/Exécution impossible/)).toBeTruthy();
    fireEvent.click(runBtn);
    expect(await screen.findByText('ok')).toBeTruthy();
    expect(screen.queryByText(/Exécution impossible/)).toBeNull();
  });
});

// ───────────────────────── Mise en page : hauteur, défilement ─────────────────────────

/** Valeurs de style calculé simulées (jsdom ne calcule pas les feuilles CSS). */
function mockComputedStyle(overrides: (el: Element) => Record<string, string> = () => ({})) {
  const base: Record<string, string> = {
    lineHeight: '20px',
    paddingTop: '0px',
    paddingBottom: '0px',
    borderTopWidth: '0px',
    borderBottomWidth: '0px',
    overflowY: 'visible',
  };
  return vi
    .spyOn(globalThis, 'getComputedStyle')
    .mockImplementation((el: Element) => ({ ...base, ...overrides(el) }) as unknown as CSSStyleDeclaration);
}

/** Définit une propriété en lecture (ou lecture/écriture) sur une instance. */
function defineProp(el: object, name: string, get: () => number, set?: (v: number) => void) {
  Object.defineProperty(el, name, { configurable: true, get, set: set ?? (() => {}) });
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

describe('CodeEditor — mise en page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hauteur minimale = minRows lignes (+ padding + bordure)', () => {
    mockComputedStyle(() => ({ paddingTop: '4px', paddingBottom: '4px', borderTopWidth: '1px', borderBottomWidth: '1px' }));
    render(<CodeEditor value="x" onChange={() => {}} minRows={3} ariaLabel="code" />);
    // 3 × 20 + 8 + 2 = 70 (scrollHeight = 0 dans jsdom).
    expect(getTextarea().style.height).toBe('70px');
  });

  it('la hauteur suit le contenu quand il dépasse le minimum', () => {
    mockComputedStyle();
    defineProp(HTMLTextAreaElement.prototype, 'scrollHeight', () => 300);
    try {
      render(<CodeEditor value="x" onChange={() => {}} minRows={2} ariaLabel="code" />);
      expect(getTextarea().style.height).toBe('300px');
    } finally {
      delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });

  it('re-mesure au changement de largeur (ResizeObserver), pas sur un simple changement de hauteur', () => {
    mockComputedStyle();
    let roCallback: () => void = () => {};
    class RO {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    render(<CodeEditor value="x" onChange={() => {}} minRows={1} ariaLabel="code" />);
    const ta = getTextarea();
    expect(ta.style.height).toBe('20px');
    let scrollHeight = 0;
    let width = 0;
    defineProp(ta, 'scrollHeight', () => scrollHeight);
    defineProp(ta, 'clientWidth', () => width);
    // Largeur inchangée → pas de re-mesure.
    scrollHeight = 90;
    act(() => roCallback());
    expect(ta.style.height).toBe('20px');
    // Largeur changée → re-mesure.
    width = 400;
    act(() => roCallback());
    expect(ta.style.height).toBe('90px');
  });

  it('barre horizontale proxy : visible si le code déborde, masquée sinon', () => {
    const { container, rerender } = render(<CodeEditor value="x" onChange={() => {}} ariaLabel="code" />);
    const hs = container.querySelector('[class*="hscroll"]') as HTMLElement;
    const inner = container.querySelector('[class*="hscrollInner"]') as HTMLElement;
    expect(hs.style.display).toBe('none');

    const ta = getTextarea();
    defineProp(ta, 'scrollWidth', () => 500);
    defineProp(ta, 'clientWidth', () => 200);
    defineProp(hs, 'clientWidth', () => 250);
    rerender(<CodeEditor value="une très longue ligne" onChange={() => {}} ariaLabel="code" />);
    expect(hs.style.display).toBe('block');
    // Largeur interne = largeur visible + course de défilement (500 − 200).
    expect(inner.style.width).toBe('550px');
  });

  it('défiler le textarea synchronise la couche colorée et la barre proxy', () => {
    const { container } = render(<CodeEditor value="x" onChange={() => {}} ariaLabel="code" />);
    const ta = getTextarea();
    const pre = container.querySelector('pre') as HTMLElement;
    const hs = container.querySelector('[class*="hscroll"]') as HTMLElement;
    const store = new Map<object, number>();
    for (const el of [pre, hs]) {
      defineProp(el, 'scrollLeft', () => store.get(el) ?? 0, (v) => store.set(el, v));
    }
    let preTop = 0;
    defineProp(pre, 'scrollTop', () => preTop, (v) => (preTop = v));
    defineProp(ta, 'scrollLeft', () => 42);
    defineProp(ta, 'scrollTop', () => 7);
    fireEvent.scroll(ta);
    expect(store.get(pre)).toBe(42);
    expect(preTop).toBe(7);
    expect(store.get(hs)).toBe(42);
  });

  it('faire glisser la barre proxy fait défiler le textarea et la couche colorée', () => {
    const { container } = render(<CodeEditor value="x" onChange={() => {}} ariaLabel="code" />);
    const ta = getTextarea();
    const pre = container.querySelector('pre') as HTMLElement;
    const hs = container.querySelector('[class*="hscroll"]') as HTMLElement;
    const store = new Map<object, number>();
    for (const el of [ta, pre]) {
      defineProp(el, 'scrollLeft', () => store.get(el) ?? 0, (v) => store.set(el, v));
    }
    defineProp(hs, 'scrollLeft', () => 15);
    fireEvent.scroll(hs);
    expect(store.get(ta)).toBe(15);
    expect(store.get(pre)).toBe(15);
  });

  it('suivi du curseur : fait défiler la fenêtre vers le bas si la ligne sort de l’écran', () => {
    mockComputedStyle();
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    render(<CodeEditor value={'a\nb'} onChange={() => {}} ariaLabel="code" />);
    const ta = getTextarea();
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(window.innerHeight - 68, window.innerHeight));
    ta.setSelectionRange(3, 3); // ligne 2
    fireEvent.keyUp(ta, { key: 'ArrowDown' });
    // Bas du curseur = top + 2 × 20 = innerHeight − 28 ; marge 30 → défile de 2 px.
    expect(scrollBy).toHaveBeenCalledWith(0, 2);
  });

  it('suivi du curseur : fait défiler la fenêtre vers le haut (sélection vers l’arrière)', () => {
    mockComputedStyle();
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    render(<CodeEditor value={'a\nb'} onChange={() => {}} ariaLabel="code" />);
    const ta = getTextarea();
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(-100, 0));
    // Extrémité active = début (ligne 1) quand la sélection va vers l'arrière.
    ta.setSelectionRange(0, 3, 'backward');
    fireEvent.click(ta);
    expect(scrollBy).toHaveBeenCalledWith(0, -130);
  });

  it('suivi du curseur : rien à faire si la ligne est visible', () => {
    mockComputedStyle();
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    render(<CodeEditor value="a" onChange={() => {}} ariaLabel="code" />);
    const ta = getTextarea();
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(200, 220));
    fireEvent.click(ta);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('suivi du curseur : sans hauteur de ligne connue, aucun défilement', () => {
    mockComputedStyle(() => ({ lineHeight: 'normal' }));
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    render(<CodeEditor value="a" onChange={() => {}} ariaLabel="code" />);
    const ta = getTextarea();
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(-500, -480));
    fireEvent.click(ta);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('suivi du curseur : fait défiler l’ancêtre défilant le plus proche (bas puis haut)', () => {
    const { container } = render(
      <div data-testid="scroller">
        <CodeEditor value={'a\nb'} onChange={() => {}} ariaLabel="code" />
      </div>
    );
    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    mockComputedStyle((el): Record<string, string> => (el === scroller ? { overflowY: 'auto' } : {}));
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    defineProp(scroller, 'scrollHeight', () => 500);
    defineProp(scroller, 'clientHeight', () => 100);
    let scrollTop = 50;
    defineProp(scroller, 'scrollTop', () => scrollTop, (v) => (scrollTop = v));
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 100));
    const ta = getTextarea();

    // Ligne 1 du curseur : top 90, bas 110 > 100 − 30 → descend de 40.
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(90, 200));
    ta.setSelectionRange(0, 0);
    fireEvent.click(ta);
    expect(scrollTop).toBe(90);

    // Curseur au-dessus de la zone visible : top −20 < 0 + 30 → remonte de 50.
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(rect(-20, 100));
    fireEvent.click(ta);
    expect(scrollTop).toBe(40);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
