import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { AddSubscriptionPopup } from './AddSubscriptionPopup';
import { DEFAULT_COLOR, DEFAULT_PALETTE, defaultLabels } from './labels';
import { defaultLabels as deleteLabels } from '../DeleteConfirmationPopup/labels';
import type { CreateEstablishment, JoinEstablishment, Program } from './types';
import type { ManagedEstablishment } from '../../types/domain';
import type { EstablishmentEvent } from '../../services/appSocket';

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

const CREATE_ESTS: CreateEstablishment[] = [
  { id: 1, name: 'Université de Sherbrooke', domainEmail: 'usherbrooke.ca', programCodes: ['GIN', 'GEL'] },
  { id: 2, name: 'Cégep de Granby', domainEmail: 'cegepgranby.qc.ca', programCodes: [] },
  { id: 3, name: 'École Polytechnique', domainEmail: 'polymtl.ca', programCodes: ['LOG'] },
];

const JOIN_ESTS: JoinEstablishment[] = [
  { id: 1, name: 'Université de Sherbrooke', domainEmail: 'usherbrooke.ca', programCount: 3 },
  { id: 2, name: 'Cégep de Granby', domainEmail: 'cegepgranby.qc.ca', programCount: 0 },
  { id: 3, name: 'École Polytechnique', domainEmail: 'polymtl.ca', programCount: 1 },
];

const PROGRAMS: Program[] = [
  { id: 10, name: 'Génie logiciel', code: 'GLO', cohort: 'Promo 70', color: '#0D9488' },
  { id: 11, name: 'Génie informatique', code: 'GIN', cohort: 'Promo 71', color: '#FFFFFF' },
  { id: 12, name: 'Génie électrique', code: 'GEL', cohort: 'Promo 72', color: '#7D7D94' },
];

const MANAGED: ManagedEstablishment[] = [
  { id: 2, name: 'Cégep de Granby', domainEmail: 'cegepgranby.qc.ca', programCount: 0 },
  { id: 1, name: 'Université de Sherbrooke', domainEmail: 'usherbrooke.ca', programCount: 3 },
  { id: 3, name: 'École Polytechnique', domainEmail: 'polymtl.ca' },
];

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Props = React.ComponentProps<typeof AddSubscriptionPopup>;

function renderPopup(overrides: Partial<Props> = {}) {
  let wsHandler: ((event: EstablishmentEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const props = {
    onClose: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onJoin: vi.fn().mockResolvedValue(undefined),
    loadCreateEstablishments: vi.fn().mockResolvedValue(CREATE_ESTS),
    loadJoinEstablishments: vi.fn().mockResolvedValue(JOIN_ESTS),
    loadEstablishmentPrograms: vi.fn().mockResolvedValue(PROGRAMS),
    subscribedProgramIds: [11, 99],
    subscribeEstablishmentUpdates: vi.fn((h: (event: EstablishmentEvent) => void) => {
      wsHandler = h;
      return unsubscribe;
    }),
    ...overrides,
  };
  const utils = render(<AddSubscriptionPopup {...props} />);
  const push = (event: EstablishmentEvent) => act(() => wsHandler!(event));
  return { ...props, ...utils, unsubscribe, push };
}

/** Titre de la modale (h1 de la boîte, pas celui d'un ErrorPopup superposé). */
function heading() {
  const scrim = document.body.firstElementChild!.firstElementChild!;
  return scrim.querySelector('h1')!.textContent;
}
/** Bouton d'option du menu, repéré par son titre. */
function option(title: string) {
  return screen.getByText(title).closest('button') as HTMLButtonElement;
}
function backButton() {
  return screen.getByRole('button', { name: t.back }) as HTMLButtonElement;
}
function input(placeholder: string) {
  return screen.getByPlaceholderText(placeholder) as HTMLInputElement;
}
function button(text: string) {
  return screen.getByText(text).closest('button') as HTMLButtonElement;
}
function hasSpinner(el: Element) {
  return el.querySelector('[class*="spinner"]') !== null;
}

// ── Raccourcis de navigation ──

async function goCreate(overrides: Partial<Props> = {}) {
  const utils = renderPopup(overrides);
  fireEvent.click(option(t.createTitle));
  await waitFor(() => expect(heading()).toBe(t.createTitle));
  return utils;
}
function openPicker() {
  fireEvent.click(screen.getByText(t.establishmentPlaceholder));
}
/** Noms listés dans le menu déroulant des établissements (vue création). */
function pickerNames() {
  return Array.from(document.querySelectorAll('ul li button > span:first-child')).map((s) => s.textContent);
}
function fillCreate({ est = 'Université de Sherbrooke', code = 'gti', name = ' Génie TI ', cohort = ' Promo 73 ' } = {}) {
  openPicker();
  fireEvent.click(screen.getByText(est));
  fireEvent.change(input(t.codePlaceholder), { target: { value: code } });
  fireEvent.change(input(t.namePlaceholder), { target: { value: name } });
  fireEvent.change(input(t.cohortPlaceholder), { target: { value: cohort } });
}

async function goJoin(overrides: Partial<Props> = {}) {
  const utils = renderPopup(overrides);
  fireEvent.click(option(t.joinTitle));
  await waitFor(() => expect(heading()).toBe(t.joinTitle));
  return utils;
}
/** Lignes (boutons) d'établissement de l'étape recherche, dans l'ordre affiché. */
function joinRows() {
  return Array.from(document.querySelectorAll('ul li > button')) as HTMLButtonElement[];
}
function joinRow(name: string) {
  return screen.getByText(name).closest('button') as HTMLButtonElement;
}
async function goPrograms(overrides: Partial<Props> = {}) {
  const utils = await goJoin(overrides);
  fireEvent.click(joinRow('Université de Sherbrooke'));
  await waitFor(() => expect(heading()).toBe('Université de Sherbrooke'));
  return utils;
}
/** Bouton d'un programme (étape sélection), repéré par son nom. */
function programRow(name: string) {
  return screen.getByText(name).closest('button') as HTMLButtonElement;
}

function manageProps(overrides: Partial<Props> = {}): Partial<Props> {
  return {
    canManageEstablishments: true,
    loadEstablishments: vi.fn().mockResolvedValue(MANAGED),
    onCreateEstablishment: vi.fn(async (name: string, domainEmail: string) => ({ id: 50, name, domainEmail, programCount: 0 })),
    onUpdateEstablishment: vi.fn(async (id: number, u: { name: string; domainEmail: string }) => ({ id, ...u })),
    onDeleteEstablishment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
async function goManage(overrides: Partial<Props> = {}) {
  const utils = renderPopup(manageProps(overrides));
  fireEvent.click(option(t.manageEstablishmentsTitle));
  await waitFor(() => expect(heading()).toBe(t.manageEstablishmentsTitle));
  return utils;
}
/** Noms des établissements de l'étape « gérer », dans l'ordre affiché. */
function managedNames() {
  return Array.from(document.querySelectorAll('ul li > div:first-child > span:first-child')).map((s) => s.textContent);
}
function managedRow(name: string) {
  return screen.getByText(name).closest('li') as HTMLLIElement;
}
function rowButton(name: string, label: 'Modifier' | 'Supprimer') {
  return managedRow(name).querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
}

describe('AddSubscriptionPopup', () => {
  // ── Menu ──

  describe('menu', () => {
    it('propose « créer » et « rejoindre », sans bouton retour ni « gérer » par défaut', () => {
      renderPopup();
      expect(heading()).toBe(t.title);
      expect(screen.getByText(t.subtitle)).toBeTruthy();
      expect(option(t.createTitle)).toBeTruthy();
      expect(option(t.joinTitle)).toBeTruthy();
      expect(screen.queryByText(t.manageEstablishmentsTitle)).toBeNull();
      expect(screen.queryByRole('button', { name: t.back })).toBeNull();
    });

    it('canCreateProgram=false masque l’option de création', () => {
      renderPopup({ canCreateProgram: false });
      expect(screen.queryByText(t.createTitle)).toBeNull();
      expect(option(t.joinTitle)).toBeTruthy();
    });

    it('canManageEstablishments=true ajoute l’option « gérer les établissements »', () => {
      renderPopup(manageProps());
      expect(option(t.manageEstablishmentsTitle)).toBeTruthy();
      expect(screen.getByText(t.manageEstablishmentsSubtitle)).toBeTruthy();
    });

    it('pendant un chargement : spinner sur l’option cliquée, options verrouillées, pas de double appel', async () => {
      let resolve: (v: CreateEstablishment[]) => void = () => {};
      const loadCreateEstablishments = vi.fn(() => new Promise<CreateEstablishment[]>((r) => (resolve = r)));
      const { loadJoinEstablishments } = renderPopup({ loadCreateEstablishments });
      fireEvent.click(option(t.createTitle));
      await waitFor(() => expect(option(t.createTitle).disabled).toBe(true));
      expect(hasSpinner(option(t.createTitle))).toBe(true);
      expect(option(t.joinTitle).disabled).toBe(true);
      expect(hasSpinner(option(t.joinTitle))).toBe(false);
      fireEvent.click(option(t.createTitle));
      fireEvent.click(option(t.joinTitle));
      expect(loadCreateEstablishments).toHaveBeenCalledTimes(1);
      expect(loadJoinEstablishments).not.toHaveBeenCalled();
      expect(heading()).toBe(t.title); // n'avance qu'après la réponse
      await act(async () => resolve(CREATE_ESTS));
      expect(heading()).toBe(t.createTitle);
    });

    it.each([
      ['rejette', vi.fn().mockRejectedValue(new Error('x'))],
      ['renvoie un non-tableau', vi.fn().mockResolvedValue(null)],
    ])('si le chargement %s : ErrorPopup et on reste sur le menu', async (_n, loadCreateEstablishments) => {
      renderPopup({ loadCreateEstablishments });
      fireEvent.click(option(t.createTitle));
      expect(await screen.findByText(t.loadError)).toBeTruthy();
      expect(heading()).toBe(t.title);
      expect(option(t.createTitle).disabled).toBe(false);
      fireEvent.click(screen.getByText(t.errorClose));
      expect(screen.queryByText(t.loadError)).toBeNull();
    });

    it('« ✕ » et le voile appellent onClose ; un clic dans la boîte ne ferme pas', () => {
      const { onClose, container } = renderPopup();
      fireEvent.click(screen.getByText('✕'));
      fireEvent.click(container.firstElementChild as HTMLElement);
      fireEvent.click(screen.getByText(t.subtitle));
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('sans reduced-motion, la fermeture attend la fin de l’animation de sortie', () => {
      stubReducedMotion(false);
      const { onClose, container } = renderPopup();
      fireEvent.click(screen.getByText('✕'));
      expect(onClose).not.toHaveBeenCalled();
      const scrim = container.firstElementChild as HTMLElement;
      expect(scrim.className).toMatch(/closing/);
      // jsdom n'a pas AnimationEvent : React écoute alors la variante préfixée webkit.
      fireEvent(scrim.firstElementChild as HTMLElement, new Event('webkitAnimationEnd', { bubbles: true }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('surcharge des libellés via labels', () => {
      renderPopup({ labels: { title: 'Nouveau', joinTitle: 'Adhérer' } });
      expect(heading()).toBe('Nouveau');
      expect(option('Adhérer')).toBeTruthy();
    });

    it('s’abonne au catalogue temps réel et se désabonne au démontage', () => {
      const { subscribeEstablishmentUpdates, unsubscribe, unmount } = renderPopup();
      expect(subscribeEstablishmentUpdates).toHaveBeenCalledTimes(1);
      unmount();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  // ── Création d'un programme ──

  describe('création', () => {
    it('ouvre le formulaire (titres dédiés) ; « retour » revient au menu', async () => {
      await goCreate();
      expect(screen.getByText(t.createSubtitle)).toBeTruthy();
      expect(screen.getByText(t.establishmentPlaceholder)).toBeTruthy();
      fireEvent.click(backButton());
      expect(heading()).toBe(t.title);
    });

    it('le menu établissement est trié, filtre sans accents et signale « aucun résultat »', async () => {
      await goCreate();
      openPicker();
      expect(pickerNames()).toEqual(['Cégep de Granby', 'École Polytechnique', 'Université de Sherbrooke']);
      fireEvent.change(input(t.searchPlaceholder), { target: { value: 'ecole' } });
      expect(pickerNames()).toEqual(['École Polytechnique']);
      fireEvent.change(input(t.searchPlaceholder), { target: { value: 'zzz' } });
      expect(screen.getByText(t.noResults)).toBeTruthy();
    });

    it('sans établissement chargé : « aucun établissement disponible »', async () => {
      await goCreate({ loadCreateEstablishments: vi.fn().mockResolvedValue([]) });
      openPicker();
      expect(screen.getByText(t.noEstablishments)).toBeTruthy();
    });

    it('choisir un établissement l’affiche et ferme le menu ; Échap et clic extérieur ferment aussi', async () => {
      await goCreate();
      openPicker();
      fireEvent.click(screen.getByText('Cégep de Granby'));
      expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
      expect(screen.queryByText(t.establishmentPlaceholder)).toBeNull();
      expect(screen.getByText('Cégep de Granby')).toBeTruthy();
      // Rouvert : l'élément choisi porte la coche (svg) ; Échap ferme.
      fireEvent.click(screen.getByText('Cégep de Granby'));
      const selected = screen.getAllByText('Cégep de Granby').map((s) => s.closest('button')).find(Boolean)!;
      expect(selected.querySelector('svg')).not.toBeNull();
      fireEvent.keyDown(input(t.searchPlaceholder), { key: 'Escape' });
      expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
      // Clic extérieur (mousedown hors du champ).
      fireEvent.click(screen.getByText('Cégep de Granby'));
      expect(input(t.searchPlaceholder)).toBeTruthy();
      fireEvent.mouseDown(screen.getByText(t.codeLabel));
      expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
    });

    it('rouvrir le menu vide la recherche précédente', async () => {
      await goCreate();
      openPicker();
      fireEvent.change(input(t.searchPlaceholder), { target: { value: 'poly' } });
      fireEvent.keyDown(input(t.searchPlaceholder), { key: 'Escape' });
      openPicker();
      expect(input(t.searchPlaceholder).value).toBe('');
      expect(pickerNames()).toHaveLength(3);
    });

    it('le code est forcé en majuscules et l’aperçu montre ses 3 premiers caractères (« ? » si vide)', async () => {
      await goCreate();
      const preview = document.querySelector('[aria-hidden="true"] > span') as HTMLElement;
      expect(preview.textContent).toBe('?');
      fireEvent.change(input(t.codePlaceholder), { target: { value: 'info' } });
      expect(input(t.codePlaceholder).value).toBe('INFO');
      expect(preview.textContent).toBe('INF');
    });

    it('« Créer » reste désactivé tant qu’un champ ou l’établissement manque', async () => {
      await goCreate();
      const submit = () => button(t.submit);
      expect(submit().disabled).toBe(true);
      fireEvent.change(input(t.codePlaceholder), { target: { value: 'GTI' } });
      fireEvent.change(input(t.namePlaceholder), { target: { value: 'Génie TI' } });
      fireEvent.change(input(t.cohortPlaceholder), { target: { value: 'Promo 73' } });
      expect(submit().disabled).toBe(true); // établissement manquant
      openPicker();
      fireEvent.click(screen.getByText('Cégep de Granby'));
      expect(submit().disabled).toBe(false);
      fireEvent.change(input(t.cohortPlaceholder), { target: { value: '   ' } });
      expect(submit().disabled).toBe(true); // espaces seuls = vide
    });

    it('signale un code déjà pris dans l’établissement choisi (insensible à la casse) et bloque', async () => {
      await goCreate();
      fillCreate({ code: 'gin' });
      expect(screen.getByText(t.codeTaken)).toBeTruthy();
      expect(input(t.codePlaceholder).getAttribute('aria-invalid')).toBe('true');
      expect(button(t.submit).disabled).toBe(true);
      // Le même code est libre dans un autre établissement.
      fireEvent.click(screen.getByText('Université de Sherbrooke'));
      fireEvent.click(screen.getByText('Cégep de Granby'));
      expect(screen.queryByText(t.codeTaken)).toBeNull();
      expect(button(t.submit).disabled).toBe(false);
    });

    it('onCreate reçoit le programme rogné avec la couleur par défaut, puis onClose', async () => {
      const { onCreate, onClose } = await goCreate();
      fillCreate();
      fireEvent.click(button(t.submit));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(onCreate).toHaveBeenCalledWith({
        name: 'Génie TI',
        code: 'GTI',
        cohort: 'Promo 73',
        color: DEFAULT_COLOR,
        establishmentId: 1,
      });
    });

    it('la pastille cliquée (aria-pressed) et la couleur libre sont envoyées', async () => {
      const { onCreate } = await goCreate();
      const swatch = screen.getByRole('button', { name: DEFAULT_PALETTE[3] });
      expect(screen.getByRole('button', { name: DEFAULT_PALETTE[0] }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(swatch);
      expect(swatch.getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: DEFAULT_PALETTE[0] }).getAttribute('aria-pressed')).toBe('false');
      fillCreate();
      fireEvent.click(button(t.submit));
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ color: DEFAULT_PALETTE[3] }));
    });

    it('le sélecteur de couleur libre remplace la couleur et ne coche aucune pastille', async () => {
      const { onCreate } = await goCreate();
      const picker = document.querySelector('input[type="color"]') as HTMLInputElement;
      fireEvent.change(picker, { target: { value: '#ff0000' } });
      expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
      fillCreate();
      fireEvent.click(button(t.submit));
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ color: '#ff0000' }));
    });

    it('palette personnalisée via la prop palette', async () => {
      await goCreate({ palette: ['#111111', '#222222'] });
      expect(screen.getByRole('button', { name: '#111111' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '#222222' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: DEFAULT_PALETTE[1] })).toBeNull();
    });

    it('si onCreate rejette : ErrorPopup, formulaire conservé, pas de fermeture', async () => {
      const { onClose } = await goCreate({ onCreate: vi.fn().mockRejectedValue(new Error('500')) });
      fillCreate();
      fireEvent.click(button(t.submit));
      expect(await screen.findByText(t.saveError)).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      expect(input(t.codePlaceholder).value).toBe('GTI');
      expect(heading()).toBe(t.createTitle);
    });

    it('pendant l’envoi : spinner, bouton verrouillé, pas de double envoi', async () => {
      let resolve: () => void = () => {};
      const onCreate = vi.fn(() => new Promise<void>((r) => (resolve = r)));
      const { onClose } = await goCreate({ onCreate });
      fillCreate();
      const submitBtn = button(t.submit);
      fireEvent.click(submitBtn);
      await waitFor(() => expect(submitBtn.disabled).toBe(true));
      expect(hasSpinner(submitBtn)).toBe(true);
      expect(backButton().disabled).toBe(true);
      fireEvent.click(submitBtn);
      expect(onCreate).toHaveBeenCalledTimes(1);
      await act(async () => resolve());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('rouvrir la création réinitialise le formulaire', async () => {
      await goCreate();
      fillCreate();
      fireEvent.click(screen.getByRole('button', { name: DEFAULT_PALETTE[2] }));
      fireEvent.click(backButton());
      fireEvent.click(option(t.createTitle));
      await waitFor(() => expect(heading()).toBe(t.createTitle));
      expect(input(t.codePlaceholder).value).toBe('');
      expect(input(t.namePlaceholder).value).toBe('');
      expect(input(t.cohortPlaceholder).value).toBe('');
      expect(screen.getByText(t.establishmentPlaceholder)).toBeTruthy();
      expect(screen.getByRole('button', { name: DEFAULT_COLOR }).getAttribute('aria-pressed')).toBe('true');
    });

    it('« Annuler » appelle onClose sans créer', async () => {
      const { onClose, onCreate } = await goCreate();
      fireEvent.click(screen.getByText(t.cancel));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onCreate).not.toHaveBeenCalled();
    });

    it('temps réel (catalog) : un code ajouté entre-temps devient « déjà pris »', async () => {
      const { push } = await goCreate();
      fillCreate({ est: 'Cégep de Granby', code: 'NEW' });
      expect(screen.queryByText(t.codeTaken)).toBeNull();
      push({ kind: 'catalog', establishmentId: 2, programs: [{ ...PROGRAMS[0], code: 'NEW' }] });
      expect(screen.getByText(t.codeTaken)).toBeTruthy();
      expect(button(t.submit).disabled).toBe(true);
    });

    it('temps réel (upserted / deleted) : le menu établissement suit le catalogue', async () => {
      const { push } = await goCreate();
      push({ kind: 'upserted', id: 4, name: 'Bishop’s', domainEmail: 'ubishops.ca', programCount: 0, programCodes: [] });
      push({ kind: 'upserted', id: 2, name: 'Cégep Granby', domainEmail: 'cegepgranby.qc.ca', programCount: 0, programCodes: [] });
      push({ kind: 'deleted', establishmentId: 3 });
      openPicker();
      expect(pickerNames()).toEqual(['Bishop’s', 'Cégep Granby', 'Université de Sherbrooke']);
    });
  });

  // ── Rejoindre un programme ──

  describe('rejoindre', () => {
    it('liste les établissements triés avec leur nombre de programmes ; ceux sans programme sont désactivés', async () => {
      await goJoin();
      expect(screen.getByText(t.joinSearchSubtitle)).toBeTruthy();
      expect(joinRows().map((b) => b.querySelector('span')!.textContent)).toEqual([
        'Cégep de Granby',
        'École Polytechnique',
        'Université de Sherbrooke',
      ]);
      expect(joinRow('Cégep de Granby').textContent).toContain(t.programCount(0));
      expect(joinRow('Cégep de Granby').disabled).toBe(true);
      expect(joinRow('École Polytechnique').textContent).toContain('1 programme');
      expect(joinRow('Université de Sherbrooke').textContent).toContain('3 programmes');
      expect(joinRow('Université de Sherbrooke').disabled).toBe(false);
    });

    it('la recherche filtre (sans accents) et signale « aucun résultat » ; liste vide → « aucun établissement »', async () => {
      await goJoin();
      fireEvent.change(input(t.searchPlaceholder), { target: { value: 'UNIVERSITE' } });
      expect(joinRows()).toHaveLength(1);
      fireEvent.change(input(t.searchPlaceholder), { target: { value: 'mcgill' } });
      expect(screen.getByText(t.noResults)).toBeTruthy();
      cleanup();
      await goJoin({ loadJoinEstablishments: vi.fn().mockResolvedValue([]) });
      expect(screen.getByText(t.noEstablishments)).toBeTruthy();
    });

    it('choisir un établissement charge ses programmes et pré-coche ceux déjà suivis', async () => {
      const { loadEstablishmentPrograms } = await goPrograms();
      expect(loadEstablishmentPrograms).toHaveBeenCalledWith(1);
      expect(screen.getByText(t.joinProgramsSubtitle)).toBeTruthy();
      expect(programRow('Génie informatique').getAttribute('aria-pressed')).toBe('true');
      expect(programRow('Génie logiciel').getAttribute('aria-pressed')).toBe('false');
      // Triés par nom ; pastille = 3 premiers caractères du code.
      const names = Array.from(document.querySelectorAll('ul li button div > span:first-child')).map((s) => s.textContent);
      expect(names).toEqual(['Génie électrique', 'Génie informatique', 'Génie logiciel']);
      expect(programRow('Génie logiciel').textContent).toContain('GLO');
      expect(programRow('Génie logiciel').textContent).toContain('Promo 70');
    });

    it('échec du chargement des programmes : ErrorPopup, on reste sur la recherche', async () => {
      await goJoin({ loadEstablishmentPrograms: vi.fn().mockRejectedValue(new Error('x')) });
      fireEvent.click(joinRow('Université de Sherbrooke'));
      expect(await screen.findByText(t.loadError)).toBeTruthy();
      expect(heading()).toBe(t.joinTitle);
    });

    it('cliquer un programme le coche / décoche ; la recherche filtre par nom, code ou cohorte', async () => {
      await goPrograms();
      fireEvent.click(programRow('Génie logiciel'));
      expect(programRow('Génie logiciel').getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(programRow('Génie logiciel'));
      expect(programRow('Génie logiciel').getAttribute('aria-pressed')).toBe('false');
      fireEvent.change(input(t.programSearchPlaceholder), { target: { value: 'gel' } });
      expect(screen.getByText('Génie électrique')).toBeTruthy();
      expect(screen.queryByText('Génie logiciel')).toBeNull();
      fireEvent.change(input(t.programSearchPlaceholder), { target: { value: 'promo 70' } });
      expect(screen.getByText('Génie logiciel')).toBeTruthy();
      expect(screen.queryByText('Génie électrique')).toBeNull();
      fireEvent.change(input(t.programSearchPlaceholder), { target: { value: 'chimie' } });
      expect(screen.getByText(t.noResults)).toBeTruthy();
    });

    it('établissement sans programme : message dédié', async () => {
      await goPrograms({ loadEstablishmentPrograms: vi.fn().mockResolvedValue([]) });
      expect(screen.getByText(t.noPrograms)).toBeTruthy();
    });

    it('« Enregistrer » envoie l’établissement et les programmes cochés, puis onClose', async () => {
      const { onJoin, onClose } = await goPrograms();
      fireEvent.click(programRow('Génie logiciel'));
      fireEvent.click(button(t.add));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(onJoin).toHaveBeenCalledWith({ establishmentId: 1, programIds: [11, 10] });
    });

    it('tout décocher est permis : onJoin reçoit [] (désabonnement)', async () => {
      const { onJoin } = await goPrograms();
      fireEvent.click(programRow('Génie informatique'));
      fireEvent.click(button(t.add));
      await waitFor(() => expect(onJoin).toHaveBeenCalledWith({ establishmentId: 1, programIds: [] }));
    });

    it('si onJoin rejette : ErrorPopup, sélection conservée, pas de fermeture', async () => {
      const { onClose } = await goPrograms({ onJoin: vi.fn().mockRejectedValue(new Error('x')) });
      fireEvent.click(button(t.add));
      expect(await screen.findByText(t.saveError)).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      expect(programRow('Génie informatique').getAttribute('aria-pressed')).toBe('true');
    });

    it('« retour » : programmes → recherche → menu', async () => {
      await goPrograms();
      fireEvent.click(backButton());
      expect(heading()).toBe(t.joinTitle);
      expect(input(t.searchPlaceholder).value).toBe('');
      fireEvent.click(backButton());
      expect(heading()).toBe(t.title);
    });

    it('« Annuler » appelle onClose sans rejoindre', async () => {
      const { onClose, onJoin } = await goPrograms();
      fireEvent.click(screen.getByText(t.cancel));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onJoin).not.toHaveBeenCalled();
    });

    it('initialView="join" ouvre directement l’adhésion en chargeant les établissements au montage', async () => {
      const { loadJoinEstablishments } = renderPopup({ initialView: 'join' });
      expect(await screen.findByText('Université de Sherbrooke')).toBeTruthy();
      expect(heading()).toBe(t.joinTitle);
      expect(loadJoinEstablishments).toHaveBeenCalledTimes(1);
      fireEvent.click(backButton());
      expect(heading()).toBe(t.title);
    });

    it('temps réel (catalog) : le décompte et la liste ouverte des programmes se mettent à jour', async () => {
      const { push } = await goPrograms();
      push({ kind: 'catalog', establishmentId: 1, programs: [PROGRAMS[0]] });
      expect(screen.getByText('Génie logiciel')).toBeTruthy();
      expect(screen.queryByText('Génie électrique')).toBeNull();
      fireEvent.click(backButton());
      expect(joinRow('Université de Sherbrooke').textContent).toContain('1 programme');
    });

    it('temps réel (upserted) : un nouvel établissement apparaît, un existant est renommé', async () => {
      const { push } = await goJoin();
      push({ kind: 'upserted', id: 4, name: 'Bishop’s', domainEmail: 'ubishops.ca', programCount: 2, programCodes: [] });
      push({ kind: 'upserted', id: 2, name: 'Cégep Granby', domainEmail: 'cegepgranby.qc.ca', programCount: 1, programCodes: [] });
      expect(joinRow('Bishop’s').textContent).toContain('2 programmes');
      expect(joinRow('Cégep Granby').disabled).toBe(false);
      expect(screen.queryByText('Cégep de Granby')).toBeNull();
    });

    it('temps réel (deleted) : l’établissement consulté disparaît et on revient à la recherche', async () => {
      const { push } = await goPrograms();
      push({ kind: 'deleted', establishmentId: 1 });
      expect(heading()).toBe(t.joinTitle);
      expect(screen.queryByText('Université de Sherbrooke')).toBeNull();
      expect(joinRows()).toHaveLength(2);
    });

    it('temps réel (deleted) d’un autre établissement : la sélection en cours est conservée', async () => {
      const { push } = await goPrograms();
      push({ kind: 'deleted', establishmentId: 3 });
      expect(heading()).toBe('Université de Sherbrooke');
      expect(programRow('Génie informatique').getAttribute('aria-pressed')).toBe('true');
    });
  });

  // ── Gestion des établissements (gardien) ──

  describe('gestion des établissements', () => {
    it('liste triée avec domaine et nombre de programmes ; « retour » revient au menu', async () => {
      const { loadEstablishments } = await goManage();
      expect(loadEstablishments).toHaveBeenCalledTimes(1);
      expect(managedNames()).toEqual(['Cégep de Granby', 'École Polytechnique', 'Université de Sherbrooke']);
      expect(managedRow('Université de Sherbrooke').textContent).toContain('usherbrooke.ca · 3 programmes');
      // Sans programCount : seulement le domaine.
      expect(managedRow('École Polytechnique').textContent).toContain('polymtl.ca');
      expect(managedRow('École Polytechnique').textContent).not.toContain('programme');
      fireEvent.click(backButton());
      expect(heading()).toBe(t.title);
    });

    it('liste vide : « aucun établissement » ; échec de chargement : ErrorPopup sur le menu', async () => {
      await goManage({ loadEstablishments: vi.fn().mockResolvedValue([]) });
      expect(screen.getByText(t.noEstablishments)).toBeTruthy();
      cleanup();
      renderPopup(manageProps({ loadEstablishments: vi.fn().mockRejectedValue(new Error('x')) }));
      fireEvent.click(option(t.manageEstablishmentsTitle));
      expect(await screen.findByText(t.loadError)).toBeTruthy();
      expect(heading()).toBe(t.title);
    });

    it('ajout : validation du domaine (format), domaine forcé en minuscules', async () => {
      await goManage();
      fireEvent.click(button(t.addEstablishment));
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(t.addEstablishment);
      const save = () => button(t.submit);
      expect(save().disabled).toBe(true);
      fireEvent.change(input(t.establishmentNamePlaceholder), { target: { value: 'Bishop’s' } });
      fireEvent.change(input(t.establishmentDomainPlaceholder), { target: { value: 'UBishops' } });
      expect(input(t.establishmentDomainPlaceholder).value).toBe('ubishops');
      expect(screen.getByText(t.establishmentDomainInvalid)).toBeTruthy();
      expect(input(t.establishmentDomainPlaceholder).getAttribute('aria-invalid')).toBe('true');
      expect(save().disabled).toBe(true);
      fireEvent.change(input(t.establishmentDomainPlaceholder), { target: { value: 'ubishops.ca' } });
      expect(screen.queryByText(t.establishmentDomainInvalid)).toBeNull();
      expect(save().disabled).toBe(false);
      fireEvent.change(input(t.establishmentNamePlaceholder), { target: { value: '  ' } });
      expect(save().disabled).toBe(true); // nom vide
    });

    it('ajout : onCreateEstablishment(nom, domaine) rognés, puis insertion triée dans la liste', async () => {
      const { onCreateEstablishment } = await goManage();
      fireEvent.click(button(t.addEstablishment));
      fireEvent.change(input(t.establishmentNamePlaceholder), { target: { value: '  Bishop’s ' } });
      fireEvent.change(input(t.establishmentDomainPlaceholder), { target: { value: ' ubishops.ca ' } });
      fireEvent.click(button(t.submit));
      await waitFor(() => expect(managedNames()).toContain('Bishop’s'));
      expect(onCreateEstablishment).toHaveBeenCalledWith('Bishop’s', 'ubishops.ca');
      expect(managedNames()[0]).toBe('Bishop’s');
      expect(screen.queryByPlaceholderText(t.establishmentNamePlaceholder)).toBeNull();
      expect(button(t.addEstablishment)).toBeTruthy();
    });

    it('ajout : Entrée enregistre, et l’écho WS arrivé avant la réponse ne dédouble pas la ligne', async () => {
      let resolve: (e: ManagedEstablishment) => void = () => {};
      const onCreateEstablishment = vi.fn(() => new Promise<ManagedEstablishment>((r) => (resolve = r)));
      const { push } = await goManage({ onCreateEstablishment });
      fireEvent.click(button(t.addEstablishment));
      fireEvent.change(input(t.establishmentNamePlaceholder), { target: { value: 'Bishop’s' } });
      fireEvent.change(input(t.establishmentDomainPlaceholder), { target: { value: 'ubishops.ca' } });
      fireEvent.keyDown(input(t.establishmentDomainPlaceholder), { key: 'Enter' });
      expect(onCreateEstablishment).toHaveBeenCalledTimes(1);
      push({ kind: 'upserted', id: 50, name: 'Bishop’s', domainEmail: 'ubishops.ca', programCount: 0, programCodes: [] });
      await act(async () => resolve({ id: 50, name: 'Bishop’s', domainEmail: 'ubishops.ca', programCount: 0 }));
      expect(managedNames().filter((n) => n === 'Bishop’s')).toHaveLength(1);
      expect(managedNames()).toHaveLength(4);
    });

    it('ajout : Échap ou « Annuler » referme le formulaire sans appel', async () => {
      const { onCreateEstablishment } = await goManage();
      fireEvent.click(button(t.addEstablishment));
      fireEvent.keyDown(input(t.establishmentNamePlaceholder), { key: 'Escape' });
      expect(screen.queryByPlaceholderText(t.establishmentNamePlaceholder)).toBeNull();
      fireEvent.click(button(t.addEstablishment));
      fireEvent.click(screen.getByText(t.cancel));
      expect(screen.queryByPlaceholderText(t.establishmentNamePlaceholder)).toBeNull();
      expect(onCreateEstablishment).not.toHaveBeenCalled();
    });

    it('domaine déjà pris (409 « duplicate-domain ») : erreur inline, levée dès que le domaine change', async () => {
      await goManage({ onCreateEstablishment: vi.fn().mockRejectedValue(new Error('duplicate-domain')) });
      fireEvent.click(button(t.addEstablishment));
      fireEvent.change(input(t.establishmentNamePlaceholder), { target: { value: 'Doublon' } });
      fireEvent.change(input(t.establishmentDomainPlaceholder), { target: { value: 'usherbrooke.ca' } });
      fireEvent.click(button(t.submit));
      expect(await screen.findByText(t.establishmentDomainTaken)).toBeTruthy();
      expect(screen.queryByText(t.saveError)).toBeNull(); // pas d'ErrorPopup
      expect(button(t.submit).disabled).toBe(true);
      fireEvent.change(input(t.establishmentDomainPlaceholder), { target: { value: 'usherbrooke.qc.ca' } });
      expect(screen.queryByText(t.establishmentDomainTaken)).toBeNull();
      expect(button(t.submit).disabled).toBe(false);
    });

    it('autre échec d’enregistrement : ErrorPopup, formulaire conservé', async () => {
      await goManage({ onCreateEstablishment: vi.fn().mockRejectedValue(new Error('500')) });
      fireEvent.click(button(t.addEstablishment));
      fireEvent.change(input(t.establishmentNamePlaceholder), { target: { value: 'X' } });
      fireEvent.change(input(t.establishmentDomainPlaceholder), { target: { value: 'x.ca' } });
      fireEvent.click(button(t.submit));
      expect(await screen.findByText(t.saveError)).toBeTruthy();
      expect(input(t.establishmentNamePlaceholder).value).toBe('X');
    });

    it('édition : pré-remplit, verrouille les autres actions, onUpdateEstablishment puis liste re-triée', async () => {
      const { onUpdateEstablishment } = await goManage();
      fireEvent.click(rowButton('Cégep de Granby', 'Modifier'));
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(t.editEstablishment);
      expect(input(t.establishmentNamePlaceholder).value).toBe('Cégep de Granby');
      expect(input(t.establishmentDomainPlaceholder).value).toBe('cegepgranby.qc.ca');
      expect(rowButton('Université de Sherbrooke', 'Supprimer').disabled).toBe(true);
      expect(button(t.addEstablishment).disabled).toBe(true);
      fireEvent.change(input(t.establishmentNamePlaceholder), { target: { value: 'Zénith collège' } });
      fireEvent.click(button(t.saveEstablishment));
      await waitFor(() => expect(managedNames()).toContain('Zénith collège'));
      expect(onUpdateEstablishment).toHaveBeenCalledWith(2, { name: 'Zénith collège', domainEmail: 'cegepgranby.qc.ca' });
      expect(managedNames()).toEqual(['École Polytechnique', 'Université de Sherbrooke', 'Zénith collège']);
      expect(button(t.addEstablishment).disabled).toBe(false);
    });

    it('suppression : confirmation (avec le nombre de programmes) puis onDeleteEstablishment ; « Annuler » ne supprime pas', async () => {
      const { onDeleteEstablishment } = await goManage();
      fireEvent.click(rowButton('Université de Sherbrooke', 'Supprimer'));
      expect(screen.getByText(t.deleteEstablishmentTitle)).toBeTruthy();
      expect(
        screen.getByText(
          'Supprimer « Université de Sherbrooke » ? Ses 3 programme(s) et tout leur contenu (cours, membres) seront aussi supprimés. Cette action est irréversible.'
        )
      ).toBeTruthy();
      fireEvent.click(screen.getByText(deleteLabels.cancel));
      expect(screen.queryByText(t.deleteEstablishmentTitle)).toBeNull();
      expect(onDeleteEstablishment).not.toHaveBeenCalled();
      fireEvent.click(rowButton('Université de Sherbrooke', 'Supprimer'));
      fireEvent.click(screen.getByText(deleteLabels.confirm));
      await waitFor(() => expect(managedNames()).not.toContain('Université de Sherbrooke'));
      expect(onDeleteEstablishment).toHaveBeenCalledWith(1);
    });

    it('suppression d’un établissement sans programme : pas de mention de cascade', async () => {
      await goManage();
      fireEvent.click(rowButton('Cégep de Granby', 'Supprimer'));
      expect(screen.getByText('Supprimer « Cégep de Granby » ? Cette action est irréversible.')).toBeTruthy();
    });

    it('suppression en échec : ErrorPopup et l’établissement reste listé', async () => {
      await goManage({ onDeleteEstablishment: vi.fn().mockRejectedValue(new Error('x')) });
      fireEvent.click(rowButton('Cégep de Granby', 'Supprimer'));
      fireEvent.click(screen.getByText(deleteLabels.confirm));
      expect(await screen.findByText(t.saveError)).toBeTruthy();
      expect(managedNames()).toContain('Cégep de Granby');
    });

    it('temps réel : catalog met à jour le décompte, deleted retire la ligne', async () => {
      const { push } = await goManage();
      push({ kind: 'catalog', establishmentId: 2, programs: [PROGRAMS[0], PROGRAMS[1]] });
      expect(managedRow('Cégep de Granby').textContent).toContain('2 programmes');
      push({ kind: 'deleted', establishmentId: 2 });
      expect(managedNames()).toEqual(['École Polytechnique', 'Université de Sherbrooke']);
    });

    it('sans loadEstablishments, l’option « gérer » ne fait rien', () => {
      renderPopup({ canManageEstablishments: true });
      fireEvent.click(option(t.manageEstablishmentsTitle));
      expect(heading()).toBe(t.title);
    });
  });

  // ── Libellés ──

  // BOGUE : le libellé par défaut du bouton de la vue « rejoindre » est mal orthographié
  // (« Enregister » au lieu de « Enregistrer », labels.ts). Ce test décrit le texte attendu.
  it.fails('le bouton « rejoindre » est libellé « Enregistrer » (faute de frappe dans labels.ts)', () => {
    expect(defaultLabels.add).toBe('Enregistrer');
  });
});
