import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { EditProfilePopup } from './EditProfilePopup';
import { DEFAULT_PALETTE, defaultLabels } from './labels';
import type { ProfileUpdate, ProfileUser } from './types';

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

const USER: ProfileUser = {
  username: 'mnormand',
  firstName: 'Michaël',
  lastName: 'Normand',
  avatarColor: '#14B8A6',
};

/** jsdom n'implémente pas URL.createObjectURL (aperçu local de la photo). */
const createObjectURL = vi.fn(() => 'blob:preview');
const revokeObjectURL = vi.fn();

/**
 * Fin d'animation : jsdom n'expose pas `AnimationEvent`, donc React écoute le nom préfixé
 * `webkitAnimationEnd` (et non `animationend`) — on dispatch ce nom-là.
 */
function fireAnimationEnd(el: HTMLElement) {
  fireEvent(el, new Event('webkitAnimationEnd', { bubbles: true }));
}

beforeEach(() => {
  stubReducedMotion(true);
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof EditProfilePopup>> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const utils = render(
    <EditProfilePopup onClose={onClose} onSave={onSave} user={USER} {...overrides} />
  );
  return { onClose, onSave, ...utils };
}

function firstNameInput() {
  return screen.getByPlaceholderText(t.firstNamePlaceholder) as HTMLInputElement;
}
function lastNameInput() {
  return screen.getByPlaceholderText(t.lastNamePlaceholder) as HTMLInputElement;
}
function saveButton() {
  return screen.getByText(t.save).closest('button') as HTMLButtonElement;
}
function fileInput() {
  return document.body.querySelector('input[type="file"]') as HTMLInputElement;
}
/** Pastille d'aperçu de l'avatar (1er span du label « avatar »). */
function preview() {
  return document.body.querySelector('label span') as HTMLElement;
}

describe('EditProfilePopup', () => {
  it('pré-remplit le formulaire, les initiales et le pseudo', () => {
    renderPopup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t.title);
    expect(firstNameInput().value).toBe('Michaël');
    expect(lastNameInput().value).toBe('Normand');
    expect(screen.getByText('MN')).toBeTruthy();
    expect(screen.getByText('@mnormand')).toBeTruthy();
    expect(screen.getByLabelText('#14B8A6').getAttribute('aria-pressed')).toBe('true');
  });

  it('sans couleur d’avatar, prend la première couleur de la palette', () => {
    renderPopup({ user: { ...USER, avatarColor: undefined } });
    expect(screen.getByLabelText(DEFAULT_PALETTE[0]).getAttribute('aria-pressed')).toBe('true');
  });

  it('les initiales suivent la saisie du prénom et du nom', () => {
    renderPopup();
    fireEvent.change(firstNameInput(), { target: { value: 'alice' } });
    fireEvent.change(lastNameInput(), { target: { value: 'dupont' } });
    expect(screen.getByText('AD')).toBeTruthy();
    expect(screen.getByText('alice dupont')).toBeTruthy();
  });

  it('bloque l’enregistrement quand le prénom ou le nom est vide', () => {
    renderPopup();
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(firstNameInput(), { target: { value: '  ' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(firstNameInput(), { target: { value: 'A' } });
    fireEvent.change(lastNameInput(), { target: { value: '' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('cliquer une pastille change la couleur ; le sélecteur libre aussi', () => {
    renderPopup();
    fireEvent.click(screen.getByLabelText('#7D7D94'));
    expect(screen.getByLabelText('#7D7D94').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('#14B8A6').getAttribute('aria-pressed')).toBe('false');
    const picker = screen
      .getByLabelText(t.addColorLabel)
      .querySelector('input') as HTMLInputElement;
    fireEvent.change(picker, { target: { value: '#123456' } });
    expect(picker.value).toBe('#123456');
    DEFAULT_PALETTE.forEach((c) =>
      expect(screen.getByLabelText(c).getAttribute('aria-pressed')).toBe('false')
    );
  });

  it('palette personnalisée via la prop palette', () => {
    renderPopup({ palette: ['#111111', '#222222'] });
    expect(screen.getByLabelText('#111111')).toBeTruthy();
    expect(screen.queryByLabelText(DEFAULT_PALETTE[1])).toBeNull();
  });

  it('onSave reçoit les champs rognés, la couleur, photo inchangée (undefined) puis onClose', async () => {
    const { onSave, onClose } = renderPopup();
    fireEvent.change(firstNameInput(), { target: { value: '  Marie ' } });
    fireEvent.change(lastNameInput(), { target: { value: ' Tremblay  ' } });
    fireEvent.click(screen.getByLabelText('#0F766E'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const update = onSave.mock.calls[0][0] as ProfileUpdate;
    expect(update).toEqual({
      firstName: 'Marie',
      lastName: 'Tremblay',
      avatarColor: '#0F766E',
      photo: undefined,
    });
    expect(update.photo).toBeUndefined();
  });

  it('avec une photo existante : aperçu en image, pas d’initiales, bouton « retirer »', () => {
    renderPopup({ user: { ...USER, avatarUrl: 'https://cdn/x.png' } });
    expect(preview().style.backgroundImage).toContain('https://cdn/x.png');
    expect(screen.queryByText('MN')).toBeNull();
    expect(screen.getByText(t.removePhoto)).toBeTruthy();
  });

  it('retirer la photo revient aux initiales et envoie photo: null', async () => {
    const { onSave, onClose } = renderPopup({
      user: { ...USER, avatarUrl: 'https://cdn/x.png' },
    });
    fireEvent.click(screen.getByText(t.removePhoto));
    expect(screen.getByText('MN')).toBeTruthy();
    expect(screen.queryByText(t.removePhoto)).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0][0] as ProfileUpdate).photo).toBeNull();
  });

  it('choisir une photo affiche l’aperçu local et envoie le fichier', async () => {
    const { onSave, onClose } = renderPopup();
    const file = new File(['img'], 'moi.png', { type: 'image/png' });
    fireEvent.change(fileInput(), { target: { files: [file] } });
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(preview().style.backgroundImage).toContain('blob:preview');
    expect(screen.queryByText('MN')).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0][0] as ProfileUpdate).photo).toBe(file);
  });

  it('remplacer un aperçu local révoque l’ancienne URL blob', () => {
    renderPopup();
    const input = fileInput();
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.png')] } });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File(['b'], 'b.png')] } });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    fireEvent.click(screen.getByText(t.removePhoto));
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('une sélection vide (annulée) ne change rien', () => {
    renderPopup();
    fireEvent.change(fileInput(), { target: { files: [] } });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByText('MN')).toBeTruthy();
  });

  it('si onSave rejette : ErrorPopup, formulaire conservé, pas de fermeture', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    const { onClose } = renderPopup({ onSave });
    fireEvent.change(firstNameInput(), { target: { value: 'Zoé' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(screen.getByText(t.errorTitle)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(firstNameInput().value).toBe('Zoé');
    fireEvent.click(screen.getByText(t.errorClose));
    expect(screen.queryByText(t.saveError)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('pendant l’enregistrement, le bouton est désactivé (pas de double envoi)', async () => {
    let resolve!: () => void;
    const onSave = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { onClose } = renderPopup({ onSave });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.queryByText(t.save)).toBeNull());
    const buttons = screen.getAllByRole('button');
    const pendingBtn = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(pendingBtn.disabled).toBe(true);
    fireEvent.click(pendingBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('« Annuler », « ✕ » et le voile appellent onClose sans enregistrer', () => {
    const { onClose, onSave } = renderPopup();
    fireEvent.click(screen.getByText(t.cancel));
    fireEvent.click(screen.getByText('✕'));
    clickBackdrop();
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sans reduced-motion, la fermeture attend la fin de l’animation', () => {
    stubReducedMotion(false);
    const { onClose } = renderPopup();
    fireEvent.click(screen.getByText(t.cancel));
    expect(onClose).not.toHaveBeenCalled();
    const box = popupOverlay().firstElementChild as HTMLElement;
    fireAnimationEnd(box);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surcharge des libellés via labels', () => {
    renderPopup({ labels: { title: 'Mon profil', save: 'OK' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Mon profil');
    expect(screen.getByText('OK')).toBeTruthy();
  });
});
