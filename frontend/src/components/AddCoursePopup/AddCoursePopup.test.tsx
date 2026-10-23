import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AddCoursePopup } from './AddCoursePopup';
import { defaultLabels } from './labels';
import type { Establishment, NewCourse, Program } from './types';

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

const ESTABLISHMENTS: Establishment[] = [
  { id: 10, name: 'Université de Sherbrooke' },
  { id: 20, name: 'Cégep de Sherbrooke' },
];

const PROGRAMS_UDES: Program[] = [
  { id: 1, name: 'Génie informatique', code: 'GIN', cohort: 'Promo 71', color: '#0D9488' },
  { id: 2, name: 'Génie électrique', code: 'GEL', cohort: 'Promo 70', color: '#14B8A6' },
];
const PROGRAMS_CEGEP: Program[] = [
  { id: 3, name: 'Sciences de la nature', code: 'SN', cohort: '2026', color: '#7D7D94' },
];

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof AddCoursePopup>> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const loadEstablishments = vi.fn().mockResolvedValue(ESTABLISHMENTS);
  const loadPrograms = vi.fn((id: number) =>
    Promise.resolve(id === 10 ? PROGRAMS_UDES : id === 20 ? PROGRAMS_CEGEP : [])
  );
  const utils = render(
    <AddCoursePopup
      onClose={onClose}
      onSave={onSave}
      loadEstablishments={loadEstablishments}
      loadPrograms={loadPrograms}
      {...overrides}
    />
  );
  return { onClose, onSave, loadEstablishments, loadPrograms, ...utils };
}

function codeInput() {
  return screen.getByPlaceholderText(t.codePlaceholder) as HTMLInputElement;
}
function titleInput() {
  return screen.getByPlaceholderText(t.titlePlaceholder) as HTMLInputElement;
}
function saveButton() {
  return screen.getByText(t.save).closest('button') as HTMLButtonElement;
}
/** Zone cliquable d'un champ à menu (établissement ou programmes), repérée par son libellé. */
function control(labelText: string) {
  const label = screen.getByText(labelText);
  return label.nextElementSibling?.firstElementChild as HTMLElement;
}
/** Ouvre le menu établissement et choisit une entrée (attend la liste chargée). */
async function pickEstablishment(name: string) {
  fireEvent.click(control(t.establishmentLabel));
  fireEvent.click(await screen.findByText(name));
}

describe('AddCoursePopup', () => {
  it('charge les établissements au montage et invite à en choisir un avant les programmes', async () => {
    const { loadEstablishments, loadPrograms } = renderPopup();
    expect(loadEstablishments).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t.establishmentPlaceholder)).toBeTruthy();
    expect(screen.getByText(t.programsPickEstablishment)).toBeTruthy();
    // Tant qu'aucun établissement n'est choisi, le menu des programmes ne s'ouvre pas.
    fireEvent.click(control(t.programsLabel));
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
    await waitFor(() => expect(loadPrograms).not.toHaveBeenCalled());
    expect(saveButton().disabled).toBe(true);
  });

  it('le menu établissement liste, filtre et signale « aucun résultat »', async () => {
    renderPopup();
    fireEvent.click(control(t.establishmentLabel));
    expect(await screen.findByText('Université de Sherbrooke')).toBeTruthy();
    expect(screen.getByText('Cégep de Sherbrooke')).toBeTruthy();
    const search = screen.getByPlaceholderText(t.establishmentSearchPlaceholder);
    fireEvent.change(search, { target: { value: 'cégep' } });
    expect(screen.queryByText('Université de Sherbrooke')).toBeNull();
    expect(screen.getByText('Cégep de Sherbrooke')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'xyz' } });
    expect(screen.getByText(t.noResults)).toBeTruthy();
  });

  it('affiche « aucun établissement » quand le chargement renvoie vide ou échoue', async () => {
    renderPopup({ loadEstablishments: vi.fn().mockRejectedValue(new Error('boom')) });
    fireEvent.click(control(t.establishmentLabel));
    expect(await screen.findByText(t.noEstablishments)).toBeTruthy();
  });

  it('Échap et un clic en dehors ferment le menu établissement', async () => {
    renderPopup();
    fireEvent.click(control(t.establishmentLabel));
    const search = await screen.findByPlaceholderText(t.establishmentSearchPlaceholder);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(t.establishmentSearchPlaceholder)).toBeNull();
    fireEvent.click(control(t.establishmentLabel));
    expect(screen.getByPlaceholderText(t.establishmentSearchPlaceholder)).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByPlaceholderText(t.establishmentSearchPlaceholder)).toBeNull();
  });

  it('choisir un établissement charge ses programmes gérables et débloque leur menu', async () => {
    const { loadPrograms } = renderPopup();
    await pickEstablishment('Université de Sherbrooke');
    expect(loadPrograms).toHaveBeenCalledWith(10);
    expect(screen.getByText('Université de Sherbrooke')).toBeTruthy();
    expect(screen.getByText(t.programsPlaceholder)).toBeTruthy();
    fireEvent.click(control(t.programsLabel));
    expect(await screen.findByText('Génie informatique')).toBeTruthy();
    expect(screen.getByText('Génie électrique')).toBeTruthy();
  });

  it('ajouter puis retirer un programme (chips)', async () => {
    renderPopup();
    await pickEstablishment('Université de Sherbrooke');
    fireEvent.click(control(t.programsLabel));
    fireEvent.click(await screen.findByText('Génie informatique'));
    expect(screen.getByText('GIN - Promo 71')).toBeTruthy();
    // Le menu reste ouvert et il n'est plus candidat.
    expect(screen.getByPlaceholderText(t.searchPlaceholder)).toBeTruthy();
    expect(screen.queryByText('Génie informatique')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retirer Génie informatique' })[1]);
    expect(screen.queryByText('GIN - Promo 71')).toBeNull();
    expect(screen.getByText(t.programsPlaceholder)).toBeTruthy();
  });

  it('la recherche de programmes filtre et signale « aucun résultat »', async () => {
    renderPopup();
    await pickEstablishment('Université de Sherbrooke');
    fireEvent.click(control(t.programsLabel));
    await screen.findByText('Génie informatique');
    const search = screen.getByPlaceholderText(t.searchPlaceholder);
    fireEvent.change(search, { target: { value: 'promo 70' } });
    expect(screen.queryByText('Génie informatique')).toBeNull();
    expect(screen.getByText('Génie électrique')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText(t.noResults)).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
  });

  it('changer d’établissement vide la sélection et recharge les programmes', async () => {
    const { loadPrograms } = renderPopup();
    await pickEstablishment('Université de Sherbrooke');
    fireEvent.click(control(t.programsLabel));
    fireEvent.click(await screen.findByText('Génie informatique'));
    expect(screen.getByText('GIN - Promo 71')).toBeTruthy();
    await pickEstablishment('Cégep de Sherbrooke');
    expect(loadPrograms).toHaveBeenLastCalledWith(20);
    expect(screen.queryByText('GIN - Promo 71')).toBeNull();
    fireEvent.click(control(t.programsLabel));
    expect(await screen.findByText('Sciences de la nature')).toBeTruthy();
    expect(screen.queryByText('Génie informatique')).toBeNull();
  });

  it('aucun programme gérable (ou échec de chargement) → message dédié', async () => {
    renderPopup({ loadPrograms: vi.fn().mockRejectedValue(new Error('boom')) });
    await pickEstablishment('Université de Sherbrooke');
    fireEvent.click(control(t.programsLabel));
    expect(await screen.findByText(t.noManageablePrograms)).toBeTruthy();
  });

  it('le code est forcé en majuscules ; code, titre et programme sont requis', async () => {
    renderPopup();
    fireEvent.change(codeInput(), { target: { value: 'gif201' } });
    expect(codeInput().value).toBe('GIF201');
    fireEvent.change(titleInput(), { target: { value: 'Algo' } });
    expect(saveButton().disabled).toBe(true); // pas de programme
    await pickEstablishment('Université de Sherbrooke');
    fireEvent.click(control(t.programsLabel));
    fireEvent.click(await screen.findByText('Génie informatique'));
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(titleInput(), { target: { value: '  ' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('onSave reçoit le nouveau cours (rogné) puis onClose', async () => {
    const { onSave, onClose } = renderPopup();
    await pickEstablishment('Université de Sherbrooke');
    fireEvent.click(control(t.programsLabel));
    fireEvent.click(await screen.findByText('Génie informatique'));
    fireEvent.click(screen.getByText('Génie électrique'));
    fireEvent.change(codeInput(), { target: { value: ' gif201 ' } });
    fireEvent.change(titleInput(), { target: { value: ' Structures ' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0] as NewCourse).toEqual({
      code: 'GIF201',
      title: 'Structures',
      programIds: [1, 2],
    });
  });

  it('si onSave rejette : ErrorPopup, formulaire conservé, pas de fermeture', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    const { onClose } = renderPopup({ onSave });
    await pickEstablishment('Université de Sherbrooke');
    fireEvent.click(control(t.programsLabel));
    fireEvent.click(await screen.findByText('Génie informatique'));
    fireEvent.change(codeInput(), { target: { value: 'GIF201' } });
    fireEvent.change(titleInput(), { target: { value: 'Algo' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(screen.getByText(t.errorTitle)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(titleInput().value).toBe('Algo');
    expect(screen.getByText('GIN - Promo 71')).toBeTruthy();
    fireEvent.click(screen.getByText(t.errorClose));
    expect(screen.queryByText(t.saveError)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('pendant la sauvegarde, le bouton est désactivé (pas de double envoi)', async () => {
    let resolve!: () => void;
    const onSave = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { onClose } = renderPopup({ onSave });
    await pickEstablishment('Université de Sherbrooke');
    fireEvent.click(control(t.programsLabel));
    fireEvent.click(await screen.findByText('Génie informatique'));
    fireEvent.change(codeInput(), { target: { value: 'GIF201' } });
    fireEvent.change(titleInput(), { target: { value: 'Algo' } });
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

  it('« Annuler », « ✕ » et le voile appellent onClose sans sauvegarder', () => {
    const { onClose, onSave, container } = renderPopup();
    fireEvent.click(screen.getByText(t.cancel));
    fireEvent.click(screen.getByText('✕'));
    fireEvent.click(container.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('surcharge des libellés via labels', () => {
    renderPopup({ labels: { title: 'Nouveau cours', save: 'OK' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nouveau cours');
    expect(screen.getByText('OK')).toBeTruthy();
  });
});
