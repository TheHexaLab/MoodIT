import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { UpdateProgramPopup } from './UpdateProgramPopup';
import { DEFAULT_PALETTE, defaultLabels } from './labels';
import type { ProgramData, ProgramUpdate } from './types';

// Depuis la coquille Popup (#106), la popup est portée dans document.body : le voile n'est plus
// dans le `container` du rendu. Le panneau reste l'enfant direct du voile. Un clic sur le voile ne
// ferme que s'il commence sur le voile (mousedown puis click).
const popupOverlay = () => document.body.querySelector('[data-variant]') as HTMLElement;
const clickBackdrop = (el: HTMLElement = popupOverlay()) => {
  fireEvent.mouseDown(el);
  fireEvent.click(el);
};

// Fermeture immédiate (pas d'attente d'animationend, non émis par jsdom) via reduced-motion.
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') ? reduce : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

const t = defaultLabels;

const PROGRAM: ProgramData = {
  name: 'Génie informatique',
  code: 'GIN',
  cohort: 'Promo 71',
  color: '#14B8A6',
};

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof UpdateProgramPopup>> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const utils = render(
    <UpdateProgramPopup onClose={onClose} onSave={onSave} program={PROGRAM} {...overrides} />
  );
  return { onClose, onSave, ...utils };
}

function codeInput() {
  return screen.getByPlaceholderText(t.codePlaceholder) as HTMLInputElement;
}
function nameInput() {
  return screen.getByPlaceholderText(t.namePlaceholder) as HTMLInputElement;
}
function cohortInput() {
  return screen.getByPlaceholderText(t.cohortPlaceholder) as HTMLInputElement;
}
function saveButton() {
  return screen.getByText(t.save).closest('button') as HTMLButtonElement;
}

describe('UpdateProgramPopup', () => {
  it('pré-remplit le formulaire avec le programme reçu', () => {
    renderPopup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t.title);
    expect(codeInput().value).toBe('GIN');
    expect(nameInput().value).toBe('Génie informatique');
    expect(cohortInput().value).toBe('Promo 71');
    // La pastille de la couleur initiale est marquée sélectionnée.
    expect(screen.getByLabelText('#14B8A6').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('#0D9488').getAttribute('aria-pressed')).toBe('false');
  });

  it('utilise la première couleur de la palette si le programme n’en a pas', () => {
    renderPopup({ program: { ...PROGRAM, color: '' } });
    expect(screen.getByLabelText(DEFAULT_PALETTE[0]).getAttribute('aria-pressed')).toBe('true');
  });

  it('le code est forcé en majuscules et l’aperçu montre ses 3 premières lettres', () => {
    renderPopup();
    fireEvent.change(codeInput(), { target: { value: 'info' } });
    expect(codeInput().value).toBe('INFO');
    expect(screen.getByText('INF')).toBeTruthy();
  });

  it('l’aperçu affiche « ? » quand le code est vide', () => {
    renderPopup();
    fireEvent.change(codeInput(), { target: { value: '' } });
    expect(screen.getByText('?')).toBeTruthy();
  });

  it('bloque l’enregistrement si un champ est vide', () => {
    renderPopup();
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: 'Nom' } });
    fireEvent.change(cohortInput(), { target: { value: '' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('signale un code déjà pris (insensible à la casse) et bloque l’enregistrement', () => {
    renderPopup({ existingCodes: ['gel', 'GMC'] });
    fireEvent.change(codeInput(), { target: { value: 'GEL' } });
    expect(screen.getByText(t.codeTaken)).toBeTruthy();
    expect(codeInput().getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(codeInput(), { target: { value: 'GIN' } });
    expect(screen.queryByText(t.codeTaken)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('cliquer une pastille change la couleur sélectionnée', () => {
    renderPopup();
    fireEvent.click(screen.getByLabelText('#7D7D94'));
    expect(screen.getByLabelText('#7D7D94').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('#14B8A6').getAttribute('aria-pressed')).toBe('false');
  });

  it('le sélecteur de couleur personnalisée change la couleur', () => {
    renderPopup();
    const picker = screen.getByLabelText(t.addColorLabel).querySelector('input') as HTMLInputElement;
    fireEvent.change(picker, { target: { value: '#123456' } });
    expect(picker.value).toBe('#123456');
    // Plus aucune pastille de la palette n'est sélectionnée.
    DEFAULT_PALETTE.forEach((c) =>
      expect(screen.getByLabelText(c).getAttribute('aria-pressed')).toBe('false')
    );
  });

  it('onSave reçoit les valeurs rognées puis onClose est appelé', async () => {
    const { onSave, onClose } = renderPopup({ existingCodes: [] });
    fireEvent.change(codeInput(), { target: { value: ' gin2 ' } });
    fireEvent.change(nameInput(), { target: { value: '  Nouveau nom ' } });
    fireEvent.change(cohortInput(), { target: { value: ' Promo 72 ' } });
    fireEvent.click(screen.getByLabelText('#0F766E'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
    const update = onSave.mock.calls[0][0] as ProgramUpdate;
    expect(update).toEqual({
      name: 'Nouveau nom',
      code: 'GIN2',
      cohort: 'Promo 72',
      color: '#0F766E',
    });
  });

  it('si onSave rejette : ErrorPopup affiché, formulaire conservé, pas de fermeture', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    const { onClose } = renderPopup({ onSave });
    fireEvent.change(nameInput(), { target: { value: 'Modifié' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(screen.getByText(t.errorTitle)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(nameInput().value).toBe('Modifié');
    // Fermer l'erreur rend le bouton de nouveau actif.
    fireEvent.click(screen.getByText(t.errorClose));
    expect(screen.queryByText(t.saveError)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('pendant la sauvegarde, le bouton est désactivé (pas de double envoi)', async () => {
    let resolve!: () => void;
    const onSave = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { onClose } = renderPopup({ onSave });
    fireEvent.click(saveButton());
    // Le libellé est remplacé par le spinner, le bouton est désactivé.
    await waitFor(() => expect(screen.queryByText(t.save)).toBeNull());
    const buttons = screen.getAllByRole('button');
    const pendingBtn = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(pendingBtn.disabled).toBe(true);
    fireEvent.click(pendingBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('« Annuler », « ✕ » et le voile appellent onClose sans sauvegarder', () => {
    const { onClose, onSave } = renderPopup();
    fireEvent.click(screen.getByText(t.cancel));
    fireEvent.click(screen.getByText('✕'));
    clickBackdrop();
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('surcharge des libellés via labels', () => {
    renderPopup({ labels: { title: 'Éditer', save: 'OK' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Éditer');
    expect(screen.getByText('OK')).toBeTruthy();
  });
});
