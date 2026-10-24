import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { UpdateCoursePopup } from './UpdateCoursePopup';
import { defaultLabels } from './labels';
import type { CourseData, CourseUpdate, Program } from './types';

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

const PROGRAMS: Program[] = [
  { id: 1, name: 'Génie informatique', code: 'GIN', cohort: 'Promo 71', color: '#0D9488' },
  { id: 2, name: 'Génie électrique', code: 'GEL', cohort: 'Promo 70', color: '#14B8A6' },
  { id: 3, name: 'Mathématiques', code: 'MAT', cohort: '2026', color: '#7D7D94' },
];

const COURSE: CourseData = {
  code: 'GIF201',
  title: 'Structures de données',
  programIds: [1],
};

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof UpdateCoursePopup>> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const utils = render(
    <UpdateCoursePopup
      onClose={onClose}
      onSave={onSave}
      course={COURSE}
      programs={PROGRAMS}
      {...overrides}
    />
  );
  return { onClose, onSave, ...utils };
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
/** Ouvre le menu des programmes (clic sur la zone de chips / le placeholder). */
function openPicker() {
  const label = screen.getByText(t.programsLabel);
  const control = label.nextElementSibling?.firstElementChild as HTMLElement;
  fireEvent.click(control);
}

describe('UpdateCoursePopup', () => {
  it('pré-remplit code, titre et programmes rattachés (chips)', () => {
    renderPopup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t.title);
    expect(codeInput().value).toBe('GIF201');
    expect(titleInput().value).toBe('Structures de données');
    expect(screen.getByText('GIN - Promo 71')).toBeTruthy();
    expect(screen.queryByText(t.programsPlaceholder)).toBeNull();
  });

  it('sans programme rattaché, affiche le placeholder et bloque l’enregistrement', () => {
    renderPopup({ course: { ...COURSE, programIds: [] } });
    expect(screen.getByText(t.programsPlaceholder)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('ignore un id de programme inconnu dans les chips', () => {
    renderPopup({ course: { ...COURSE, programIds: [1, 999] } });
    expect(screen.getAllByRole('button', { name: /Retirer/ })).toHaveLength(2); // chip + sa croix
  });

  it('retirer un chip détache le programme', () => {
    renderPopup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retirer Génie informatique' })[1]);
    expect(screen.queryByText('GIN - Promo 71')).toBeNull();
    expect(screen.getByText(t.programsPlaceholder)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('le menu liste seulement les programmes non rattachés ; en choisir un ajoute un chip', () => {
    renderPopup();
    openPicker();
    expect(screen.getByPlaceholderText(t.searchPlaceholder)).toBeTruthy();
    expect(screen.queryByText('Génie informatique')).toBeNull();
    expect(screen.getByText('Génie électrique')).toBeTruthy();
    expect(screen.getByText('Cohorte 2026')).toBeTruthy();
    fireEvent.click(screen.getByText('Mathématiques'));
    expect(screen.getByText('MAT - 2026')).toBeTruthy();
    // Il n'est plus candidat.
    expect(screen.queryByText('Mathématiques')).toBeNull();
  });

  it('la recherche filtre par nom, code ou cohorte ; « aucun résultat » sinon', () => {
    renderPopup();
    openPicker();
    const search = screen.getByPlaceholderText(t.searchPlaceholder);
    fireEvent.change(search, { target: { value: 'gel' } });
    expect(screen.getByText('Génie électrique')).toBeTruthy();
    expect(screen.queryByText('Mathématiques')).toBeNull();
    fireEvent.change(search, { target: { value: '2026' } });
    expect(screen.getByText('Mathématiques')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText(t.noResults)).toBeTruthy();
  });

  it('affiche « aucun programme disponible » quand tous sont rattachés', () => {
    renderPopup({ course: { ...COURSE, programIds: [1, 2, 3] } });
    openPicker();
    expect(screen.getByText(t.noCandidates)).toBeTruthy();
  });

  it('Échap et un clic en dehors ferment le menu', () => {
    renderPopup();
    openPicker();
    fireEvent.keyDown(screen.getByPlaceholderText(t.searchPlaceholder), { key: 'Escape' });
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
    openPicker();
    expect(screen.getByPlaceholderText(t.searchPlaceholder)).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
  });

  it('le code est forcé en majuscules ; code ou titre vide bloque', () => {
    renderPopup();
    fireEvent.change(codeInput(), { target: { value: 'gif202' } });
    expect(codeInput().value).toBe('GIF202');
    fireEvent.change(titleInput(), { target: { value: '   ' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(titleInput(), { target: { value: 'T' } });
    fireEvent.change(codeInput(), { target: { value: '' } });
    expect(saveButton().disabled).toBe(true);
  });

  // Garde : un cours rattaché à plusieurs programmes, ouvert depuis l'un d'eux, pré-remplit
  // TOUS ses programmes (et non le seul programme actif fourni dans course.programIds).
  it('loadProgramIds : ajoute les programmes rattachés et bloque l’enregistrement pendant le chargement', async () => {
    let resolve!: (ids: number[]) => void;
    const loadProgramIds = vi.fn(() => new Promise<number[]>((r) => (resolve = r)));
    const { onSave } = renderPopup({ loadProgramIds });
    expect(loadProgramIds).toHaveBeenCalledTimes(1);
    expect(saveButton().disabled).toBe(true);
    resolve([1, 3]);
    expect(await screen.findByText('MAT - 2026')).toBeTruthy();
    expect(screen.getByText('GIN - Promo 71')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0][0] as CourseUpdate).programIds).toEqual([1, 3]);
  });

  it('loadProgramIds en échec : ErrorPopup, sélection verrouillée et enregistrement bloqué', async () => {
    // Une liste partielle enregistrée retirerait en silence les programmes non affichés.
    const { onSave } = renderPopup({ loadProgramIds: vi.fn().mockRejectedValue(new Error('panne')) });
    expect(await screen.findByText(t.loadProgramsError)).toBeTruthy();
    expect(screen.getByText('GIN - Promo 71')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    const field = screen.getByText('GIN - Promo 71').closest('[aria-disabled]') as HTMLElement;
    expect(field.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(field); // le menu ne s'ouvre pas
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
  });

  it('pendant le chargement, la sélection est verrouillée : ni ajout ni retrait possible', async () => {
    let resolve!: (ids: number[]) => void;
    const loadProgramIds = vi.fn(() => new Promise<number[]>((r) => (resolve = r)));
    const { onSave } = renderPopup({ loadProgramIds });
    const field = screen.getByText('GIN - Promo 71').closest('[aria-disabled]') as HTMLElement;
    expect(field.getAttribute('aria-disabled')).toBe('true');
    expect(field.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(field); // ouvrir le menu : sans effet
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /^Retirer / })[0]); // retirer : sans effet
    expect(screen.getByText('GIN - Promo 71')).toBeTruthy();

    // Réponse reçue : tous les programmes rattachés sont là, la sélection se déverrouille.
    resolve([1, 3]);
    expect(await screen.findByText('MAT - 2026')).toBeTruthy();
    await waitFor(() => expect(field.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0][0] as CourseUpdate).programIds).toEqual([1, 3]);
  });

  it('onSave reçoit le cours modifié (rogné) puis onClose', async () => {
    const { onSave, onClose } = renderPopup();
    fireEvent.change(codeInput(), { target: { value: ' gif300 ' } });
    fireEvent.change(titleInput(), { target: { value: '  Algo ' } });
    openPicker();
    fireEvent.click(screen.getByText('Génie électrique'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0] as CourseUpdate).toEqual({
      code: 'GIF300',
      title: 'Algo',
      programIds: [1, 2],
    });
  });

  it('si onSave rejette : ErrorPopup, formulaire conservé, pas de fermeture', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    const { onClose } = renderPopup({ onSave });
    fireEvent.change(titleInput(), { target: { value: 'Modifié' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(titleInput().value).toBe('Modifié');
    fireEvent.click(screen.getByText(t.errorClose));
    expect(screen.queryByText(t.saveError)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('pendant la sauvegarde, le bouton est désactivé (pas de double envoi)', async () => {
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

  it('« Annuler », « ✕ » et le voile appellent onClose sans sauvegarder', () => {
    const { onClose, onSave } = renderPopup();
    fireEvent.click(screen.getByText(t.cancel));
    fireEvent.click(screen.getByText('✕'));
    clickBackdrop();
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('surcharge des libellés via labels', () => {
    renderPopup({ labels: { title: 'Éditer le cours', save: 'OK' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Éditer le cours');
    expect(screen.getByText('OK')).toBeTruthy();
  });
});
