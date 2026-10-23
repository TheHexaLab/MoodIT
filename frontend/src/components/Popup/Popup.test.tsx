import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Popup } from './Popup';
import { usePopupController } from './popupController';
import { PopupVariant } from './popupVariant';
import { useEffect, useRef } from 'react';

// jsdom ne fournit pas matchMedia ; reduced-motion → fermeture immédiate (pas d'animationend).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

function Host({
  onClose,
  variant = PopupVariant.Form,
  closeOnEscape,
  nested,
}: {
  onClose: () => void;
  variant?: PopupVariant;
  closeOnEscape?: boolean;
  nested?: React.ReactNode;
}) {
  const popup = usePopupController();
  return (
    <Popup
      variant={variant}
      label="Titre du test"
      onClose={onClose}
      controller={popup}
      closeOnEscape={closeOnEscape}
    >
      <h1>Titre du test</h1>
      <input placeholder="Nom" />
      <button type="button" onClick={() => popup.requestClose(onClose)}>
        Annuler
      </button>
      <button type="button" onClick={() => popup.requestClose(() => onClose())}>
        Valider
      </button>
      {nested}
    </Popup>
  );
}

const focused = () => document.activeElement;

describe('Popup', () => {
  it('est un dialogue modal nommé, porté dans body, dont le panneau est le div enfant du voile', () => {
    const { container } = render(<Host onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Titre du test' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(container.contains(dialog)).toBe(false); // portail
    const overlay = dialog.parentElement as HTMLElement;
    expect(overlay.dataset.variant).toBe('form');
    expect(overlay.firstElementChild).toBe(dialog);
  });

  it("déplace le focus sur le premier champ à l'ouverture et le rend au déclencheur à la fermeture", () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<Host onClose={() => {}} />);
    expect(focused()).toBe(screen.getByPlaceholderText('Nom'));
    unmount();
    expect(focused()).toBe(trigger);
    trigger.remove();
  });

  it('confine Tab et Maj+Tab dans le panneau', () => {
    render(<Host onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const input = screen.getByPlaceholderText('Nom');
    const last = screen.getByRole('button', { name: 'Valider' });
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(focused()).toBe(input);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(focused()).toBe(last);
  });

  it('Échap et le clic sur le voile ferment ; un bouton ferme via le contrôleur', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clic qui COMMENCE dans le panneau et finit sur le voile (sélection de texte) : ne ferme pas.
    fireEvent.mouseDown(screen.getByRole('dialog'));
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("Échap peut être désactivé, et un Échap déjà traité par le contenu n'est pas repris", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Host onClose={onClose} closeOnEscape={false} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    unmount();

    render(<Host onClose={onClose} />);
    const input = screen.getByPlaceholderText('Nom');
    input.addEventListener('keydown', (e) => e.preventDefault());
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Échap dans une popup imbriquée ne ferme pas la popup parente', () => {
    const onCloseParent = vi.fn();
    const onCloseChild = vi.fn();
    render(
      <Host
        onClose={onCloseParent}
        nested={
          <Popup variant={PopupVariant.Confirm} label="Confirmer" onClose={onCloseChild}>
            <h2>Confirmer</h2>
            <button type="button">OK</button>
          </Popup>
        }
      />
    );
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Confirmer' }), { key: 'Escape' });
    expect(onCloseChild).toHaveBeenCalledTimes(1);
    expect(onCloseParent).not.toHaveBeenCalled();
  });

  it('la variante Alert a le rôle alertdialog', () => {
    render(<Host onClose={() => {}} variant={PopupVariant.Alert} />);
    expect(screen.getByRole('alertdialog', { name: 'Titre du test' })).toBeTruthy();
  });
});

// ── Comportements fins de la coquille (confinement, focus, voile, animation) ───

/** Popup minimale dont le contenu est fourni par le test. */
function Bare({
  children,
  onClose = () => {},
  closeOnBackdrop,
}: {
  children?: React.ReactNode;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
}) {
  return (
    <Popup
      variant={PopupVariant.Form}
      label="Nue"
      onClose={onClose}
      closeOnBackdrop={closeOnBackdrop}
    >
      {children}
    </Popup>
  );
}

const dialog = () => screen.getByRole('dialog');
const overlayOf = () => dialog().parentElement as HTMLElement;
/** Envoie Tab (ou Maj+Tab) au dialogue ; renvoie true si le défaut a été empêché. */
function tab(shiftKey = false): boolean {
  return !fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey });
}

describe('Popup — confinement de Tab', () => {
  function renderThree() {
    render(
      <Bare>
        <button type="button">Un</button>
        <button type="button">Deux</button>
        <button type="button">Trois</button>
      </Bare>
    );
    return ['Un', 'Deux', 'Trois'].map((name) => screen.getByRole('button', { name }));
  }

  it('Tab sur un élément du milieu laisse le navigateur avancer (pas de saut forcé)', () => {
    const [, deux] = renderThree();
    deux.focus();
    expect(tab()).toBe(false);
    expect(focused()).toBe(deux);
    expect(tab(true)).toBe(false);
    expect(focused()).toBe(deux);
  });

  it("une autre touche que Tab n'est jamais interceptée, même sur le dernier ou le premier", () => {
    const [un, , trois] = renderThree();
    for (const [el, key, shiftKey] of [
      [trois, 'a', false],
      [trois, 'ArrowDown', false],
      [trois, 'Enter', false],
      [un, 'ArrowUp', true],
    ] as const) {
      el.focus();
      // fireEvent renvoie false si l'événement a été annulé (preventDefault).
      expect(fireEvent.keyDown(dialog(), { key, shiftKey })).toBe(true);
      expect(focused()).toBe(el);
    }
  });

  it('Tab sur le dernier revient au premier ; Maj+Tab sur le premier va au dernier', () => {
    const [un, , trois] = renderThree();
    trois.focus();
    expect(tab()).toBe(true);
    expect(focused()).toBe(un);
    expect(tab(true)).toBe(true);
    expect(focused()).toBe(trois);
  });

  it('focus sur le panneau lui-même : Tab va au premier, Maj+Tab au dernier', () => {
    const [un, , trois] = renderThree();
    dialog().focus();
    expect(tab()).toBe(true);
    expect(focused()).toBe(un);
    dialog().focus();
    expect(tab(true)).toBe(true);
    expect(focused()).toBe(trois);
  });

  it('focus hors du panneau : Tab va au premier, Maj+Tab au dernier', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const [un, , trois] = renderThree();
    outside.focus();
    expect(tab()).toBe(true);
    expect(focused()).toBe(un);
    outside.focus();
    expect(tab(true)).toBe(true);
    expect(focused()).toBe(trois);
    outside.remove();
  });

  it('panneau sans élément focalisable : Tab garde le focus sur le panneau', () => {
    render(
      <Bare>
        <p>Texte seul</p>
      </Bare>
    );
    expect(focused()).toBe(dialog());
    expect(tab()).toBe(true);
    expect(focused()).toBe(dialog());
    expect(tab(true)).toBe(true);
    expect(focused()).toBe(dialog());
  });

  it("Tab ne remonte pas au-delà de la popup (pas d'écouteur global déclenché)", () => {
    const [, deux] = renderThree();
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    deux.focus();
    tab();
    window.removeEventListener('keydown', onWindowKey);
    expect(onWindowKey).not.toHaveBeenCalled();
  });

  it('ignore tabindex=-1, désactivés, et contenus [hidden] / aria-hidden', () => {
    render(
      <Bare>
        <button type="button" tabIndex={-1}>
          Hors tab
        </button>
        <div aria-hidden="true">
          <button type="button">Caché aria</button>
        </div>
        <button type="button">Premier</button>
        <button type="button">Dernier</button>
        <button type="button" disabled>
          Désactivé
        </button>
        <div hidden>
          <button type="button">Caché hidden</button>
        </div>
      </Bare>
    );
    const first = screen.getByRole('button', { name: 'Premier' });
    const last = screen.getByRole('button', { name: 'Dernier' });
    expect(focused()).toBe(first); // focus initial : premier focalisable retenu
    last.focus();
    tab();
    expect(focused()).toBe(first);
    tab(true);
    expect(focused()).toBe(last);
  });

  it("ignore les éléments sans boîte affichée quand d'autres en ont une", () => {
    render(
      <Bare>
        <button type="button">Visible 1</button>
        <button type="button">Visible 2</button>
        <button type="button">Invisible</button>
      </Bare>
    );
    const v1 = screen.getByRole('button', { name: 'Visible 1' });
    const v2 = screen.getByRole('button', { name: 'Visible 2' });
    const box = [{}] as unknown as DOMRectList;
    v1.getClientRects = () => box;
    v2.getClientRects = () => box;
    v2.focus();
    tab();
    expect(focused()).toBe(v1);
    tab(true);
    expect(focused()).toBe(v2);
  });
});

describe('Popup — focus initial et restitution', () => {
  it('[data-autofocus] prime sur le premier champ', () => {
    render(
      <Bare>
        <input placeholder="Champ" />
        <button type="button" data-autofocus>
          Cible
        </button>
      </Bare>
    );
    expect(focused()).toBe(screen.getByRole('button', { name: 'Cible' }));
  });

  it('le premier champ (input/textarea/select) prime sur un bouton qui le précède', () => {
    render(
      <Bare>
        <button type="button">Bouton</button>
        <textarea placeholder="Zone" />
      </Bare>
    );
    expect(focused()).toBe(screen.getByPlaceholderText('Zone'));
  });

  it('sans champ : le premier élément focalisable', () => {
    render(
      <Bare>
        <a href="#x">Lien</a>
        <button type="button">Bouton</button>
      </Bare>
    );
    expect(focused()).toBe(screen.getByRole('link', { name: 'Lien' }));
  });

  it("un focus déjà posé dans le panneau par le contenu (effet enfant) n'est pas écrasé", () => {
    // Note : l'attribut `autoFocus` au tout premier montage est sans effet ici, car le portail
    // n'attache son hôte au document qu'après le commit des enfants ; c'est donc un effet
    // enfant (exécuté avant celui de la popup) qui représente « le contenu a déjà choisi ».
    function FocusOnMount() {
      const ref = useRef<HTMLButtonElement>(null);
      useEffect(() => ref.current?.focus(), []);
      return (
        <button ref={ref} type="button">
          Auto
        </button>
      );
    }
    render(
      <Bare>
        <input placeholder="Champ" />
        <FocusOnMount />
      </Bare>
    );
    expect(focused()).toBe(screen.getByRole('button', { name: 'Auto' }));
  });

  it('ne rend pas le focus à un déclencheur retiré du document entre-temps', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(
      <Bare>
        <button type="button">X</button>
      </Bare>
    );
    trigger.remove();
    const spy = vi.spyOn(trigger, 'focus');
    unmount();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Popup — clic sur le voile', () => {
  it('closeOnBackdrop=false : un clic complet sur le voile ne ferme pas', () => {
    const onClose = vi.fn();
    render(<Bare onClose={onClose} closeOnBackdrop={false} />);
    fireEvent.mouseDown(overlayOf());
    fireEvent.click(overlayOf());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('un clic sur le voile sans mousedown préalable sur le voile ne ferme pas', () => {
    const onClose = vi.fn();
    render(<Bare onClose={onClose} />);
    fireEvent.click(overlayOf());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('un clic dans le panneau ne ferme jamais, et consomme le geste', () => {
    const onClose = vi.fn();
    render(<Bare onClose={onClose} />);
    fireEvent.mouseDown(overlayOf());
    fireEvent.click(dialog()); // remonte au voile, mais la cible est le panneau
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(overlayOf()); // le mousedown précédent a été consommé
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * React écoute `webkitAnimationEnd` sous jsdom (pas d'AnimationEvent, mais une propriété de
 * style préfixée) : on émet ce nom-là pour atteindre `onAnimationEnd`.
 */
function animationEnd(el: HTMLElement) {
  fireEvent(el, new Event('webkitAnimationEnd', { bubbles: true }));
}

describe('Popup — animation de fermeture', () => {
  const reducedMotion = window.matchMedia;
  function enableAnimations() {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }
  afterEach(() => {
    window.matchMedia = reducedMotion;
    vi.useRealTimers();
  });

  it('pose la classe de sortie, ferme au délai de secours, une seule fois malgré deux demandes', () => {
    enableAnimations();
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Bare onClose={onClose}>
        <button type="button">X</button>
      </Bare>
    );
    const before = overlayOf().className;
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(overlayOf().className).not.toBe(before);
    vi.advanceTimersByTime(399);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('animationend du panneau ferme tout de suite et annule le délai de secours', () => {
    enableAnimations();
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Bare onClose={onClose}>
        <button type="button">X</button>
      </Bare>
    );
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    animationEnd(dialog());
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("un animationend remonté d'un enfant ne ferme pas ; le délai de secours le fait", () => {
    enableAnimations();
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Bare onClose={onClose}>
        <button type="button">X</button>
      </Bare>
    );
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    animationEnd(screen.getByRole('button', { name: 'X' }));
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requestClose(action) du contrôleur exécute l'action et non onClose, après l'animation", () => {
    enableAnimations();
    const onClose = vi.fn();
    const action = vi.fn();
    function WithController() {
      const popup = usePopupController();
      return (
        <Popup variant={PopupVariant.Form} label="Nue" onClose={onClose} controller={popup}>
          <button type="button" onClick={() => popup.requestClose(action)}>
            Valider
          </button>
        </Popup>
      );
    }
    render(<WithController />);
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(action).not.toHaveBeenCalled();
    animationEnd(dialog());
    expect(action).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('démontée pendant la sortie : le délai de secours est annulé', () => {
    enableAnimations();
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(<Bare onClose={onClose} />);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    unmount();
    vi.advanceTimersByTime(1000);
    expect(onClose).not.toHaveBeenCalled();
  });
});
