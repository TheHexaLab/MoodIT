import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { JoinCoursesPopup } from './JoinCoursesPopup';
import { defaultLabels } from './labels';
import type { JoinableCourse } from './types';

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

const COURSES: JoinableCourse[] = [
  { id: 1, code: 'GIF201', title: 'Structures de données' },
  { id: 2, code: 'GIF301', title: 'Algorithmes' },
  { id: 3, code: 'MAT101', title: 'Calcul' },
];

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof JoinCoursesPopup>> = {}) {
  const onClose = vi.fn();
  const onJoin = vi.fn();
  const loadCourses = vi.fn().mockResolvedValue(COURSES);
  const loadJoinedCourseIds = vi.fn().mockResolvedValue([2]);
  const utils = render(
    <JoinCoursesPopup
      programName="Génie informatique"
      loadCourses={loadCourses}
      loadJoinedCourseIds={loadJoinedCourseIds}
      onJoin={onJoin}
      onClose={onClose}
      {...overrides}
    />
  );
  return { onClose, onJoin, loadCourses, loadJoinedCourseIds, ...utils };
}

function courseButton(title: string) {
  return screen.getByText(title).closest('button') as HTMLButtonElement;
}
function joinButton() {
  return screen.getByText(t.join).closest('button') as HTMLButtonElement;
}

describe('JoinCoursesPopup', () => {
  it('affiche un état de chargement, puis la liste avec les cours déjà suivis pré-cochés', async () => {
    const { loadCourses, loadJoinedCourseIds } = renderPopup();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(t.subtitle('Génie informatique'))).toBeTruthy();
    expect(joinButton().disabled).toBe(true); // rien à rejoindre tant que ça charge
    expect(await screen.findByText('Structures de données')).toBeTruthy();
    expect(loadCourses).toHaveBeenCalledTimes(1);
    expect(loadJoinedCourseIds).toHaveBeenCalledTimes(1);
    expect(courseButton('Algorithmes').getAttribute('aria-pressed')).toBe('true');
    expect(courseButton('Calcul').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByText('GIF')).toHaveLength(2); // pastille = 3 premières lettres du code
    expect(joinButton().disabled).toBe(false);
  });

  it('sans cours : message dédié, pas de barre de recherche, bouton désactivé', async () => {
    renderPopup({ loadCourses: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText(t.noCourses)).toBeTruthy();
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
    expect(joinButton().disabled).toBe(true);
  });

  it('échec de chargement → alerte + « réessayer » relance les deux chargements', async () => {
    const loadCourses = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(COURSES);
    const { loadJoinedCourseIds } = renderPopup({ loadCourses });
    expect(await screen.findByText(t.loadError)).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText(t.retry));
    expect(await screen.findByText('Calcul')).toBeTruthy();
    expect(loadCourses).toHaveBeenCalledTimes(2);
    expect(loadJoinedCourseIds).toHaveBeenCalledTimes(2);
  });

  it('un retour non-tableau est traité comme une erreur de chargement', async () => {
    renderPopup({ loadJoinedCourseIds: vi.fn().mockResolvedValue(null) });
    expect(await screen.findByText(t.loadError)).toBeTruthy();
  });

  it('cliquer un cours le coche / décoche', async () => {
    renderPopup();
    await screen.findByText('Calcul');
    fireEvent.click(courseButton('Calcul'));
    expect(courseButton('Calcul').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(courseButton('Calcul'));
    expect(courseButton('Calcul').getAttribute('aria-pressed')).toBe('false');
  });

  it('la recherche filtre par code ou titre ; « aucun résultat » sinon', async () => {
    renderPopup();
    await screen.findByText('Calcul');
    const search = screen.getByPlaceholderText(t.searchPlaceholder);
    fireEvent.change(search, { target: { value: 'gif' } });
    expect(screen.getByText('Structures de données')).toBeTruthy();
    expect(screen.queryByText('Calcul')).toBeNull();
    fireEvent.change(search, { target: { value: 'calcul' } });
    expect(screen.getByText('Calcul')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText(t.noResults)).toBeTruthy();
  });

  it('« Rejoindre » envoie les ids cochés (pré-cochés compris) puis ferme', async () => {
    const { onJoin, onClose } = renderPopup();
    await screen.findByText('Calcul');
    fireEvent.click(courseButton('Calcul'));
    fireEvent.click(joinButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJoin).toHaveBeenCalledWith([2, 3]);
  });

  it('tout décocher est permis : onJoin reçoit [] (désinscription)', async () => {
    const { onJoin, onClose } = renderPopup();
    await screen.findByText('Calcul');
    fireEvent.click(courseButton('Algorithmes'));
    expect(joinButton().disabled).toBe(false);
    fireEvent.click(joinButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJoin).toHaveBeenCalledWith([]);
  });

  it('si onJoin rejette : ErrorPopup, sélection conservée, pas de fermeture', async () => {
    const onJoin = vi.fn().mockRejectedValue(new Error('boom'));
    const { onClose } = renderPopup({ onJoin });
    await screen.findByText('Calcul');
    fireEvent.click(courseButton('Calcul'));
    fireEvent.click(joinButton());
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(screen.getByText(t.errorTitle)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(courseButton('Calcul').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText(t.errorClose));
    expect(screen.queryByText(t.saveError)).toBeNull();
    expect(joinButton().disabled).toBe(false);
  });

  it('pendant l’adhésion, le bouton est désactivé (pas de double envoi)', async () => {
    let resolve!: () => void;
    const onJoin = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { onClose } = renderPopup({ onJoin });
    await screen.findByText('Calcul');
    fireEvent.click(joinButton());
    await waitFor(() => expect(screen.queryByText(t.join)).toBeNull());
    const buttons = screen.getAllByRole('button');
    const pendingBtn = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(pendingBtn.disabled).toBe(true);
    fireEvent.click(pendingBtn);
    expect(onJoin).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('« Annuler », « ✕ » et le voile appellent onClose sans rejoindre', async () => {
    const { onClose, onJoin } = renderPopup();
    await screen.findByText('Calcul');
    fireEvent.click(screen.getByText(t.cancel));
    fireEvent.click(screen.getByText('✕'));
    clickBackdrop();
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('surcharge des libellés via labels', async () => {
    renderPopup({ labels: { title: 'Mes cours', join: 'Go' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Mes cours');
    expect(await screen.findByText('Go')).toBeTruthy();
  });
});
