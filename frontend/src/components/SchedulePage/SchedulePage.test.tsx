import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SchedulePage, { type ScheduleApi } from './SchedulePage';
import type {
  ScheduleColor,
  ScheduleCourse,
  ScheduleSession,
  ScheduleTask,
} from '../../types/domain';

// jsdom ne fournit pas matchMedia ; reduced-motion → les fenêtres se ferment sans animation et une
// tâche cochée quitte la liste sans glisser.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Mercredi 28 octobre 2026 : la semaine du dimanche 25 au samedi 31 octobre. */
const NOW = new Date(2026, 9, 28, 12, 0);
const COURSES: ScheduleCourse[] = [
  { id: 10, code: 'INF201', title: 'Structures de données', programId: 1 },
  { id: 11, code: 'MAT265', programId: 2 },
];
/** Enseignant de MAT265, étudiant d'INF201. */
const TEACHER: ScheduleCourse[] = [COURSES[0], { ...COURSES[1], canManage: true }];

/** Date ISO, `day` jours après le dimanche `week` (1 = lundi, 3 = mercredi, 5 = vendredi). */
const at = (week: Date, day: number, hour: number, minute = 0) => {
  const date = new Date(week);
  date.setDate(date.getDate() + day);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

/** Deux séances par semaine : lundi (INF201) et mercredi (MAT265). */
const weekly = async (weekStart: Date): Promise<ScheduleSession[]> => [
  {
    id: 1,
    courseId: 10,
    kind: 'Cours',
    room: 'C1-3125',
    start: at(weekStart, 1, 8, 30),
    end: at(weekStart, 1, 10, 15),
  },
  {
    id: 2,
    courseId: 11,
    kind: 'Laboratoire',
    room: 'D7-2021',
    start: at(weekStart, 3, 13, 30),
    end: at(weekStart, 3, 15, 15),
  },
];

const task = (
  overrides: Partial<ScheduleTask> & Pick<ScheduleTask, 'id' | 'title' | 'start' | 'end'>
): ScheduleTask => ({
  courseId: null,
  reminder: null,
  notes: '',
  color: 'blue',
  done: false,
  allDay: false,
  deadline: false,
  ...overrides,
});

/**
 * Tutorat le mercredi, par-dessus le labo de MAT265 ; une lecture faite le vendredi, liée à INF201 ;
 * une remise d'INF201 (devoir du cours) le mardi à 17 h.
 */
const weeklyTasks = async (weekStart: Date): Promise<ScheduleTask[]> => [
  task({
    id: 7,
    title: 'Tutorat',
    start: at(weekStart, 3, 14),
    end: at(weekStart, 3, 15),
    color: 'rose',
  }),
  task({
    id: 8,
    title: 'Lire le chapitre 4',
    start: at(weekStart, 5, 9),
    end: at(weekStart, 5, 10),
    courseId: 10,
    reminder: 30,
    notes: 'p. 80',
    color: 'green',
    done: true,
  }),
  task({
    id: 9,
    title: 'Rapport de labo',
    start: at(weekStart, 2, 17),
    end: at(weekStart, 2, 17),
    courseId: 10,
    deadline: true,
    courseDeadline: true,
    notes: 'Format PDF',
  }),
];

function makeApi(overrides: Partial<ScheduleApi> = {}) {
  return {
    fetchSessions: vi.fn(weekly),
    fetchTasks: vi.fn(weeklyTasks),
    createTask: vi.fn(async (input) => ({ ...input, id: 50 })),
    updateTask: vi.fn(async (id, input) => ({ ...input, id })),
    deleteTask: vi.fn(async () => {}),
    createSessions: vi.fn(async (input) => [{ ...input, id: 60 }]),
    fetchCourseColors: vi.fn(async (): Promise<Record<number, ScheduleColor>> => ({})),
    setCourseColor: vi.fn(async () => {}),
    ...overrides,
  } satisfies ScheduleApi;
}

function setup(props: Partial<React.ComponentProps<typeof SchedulePage>> = {}) {
  const onOpenCourse = vi.fn();
  const api = (props.api as ReturnType<typeof makeApi> | undefined) ?? makeApi();
  render(
    <SchedulePage courses={COURSES} onOpenCourse={onOpenCourse} now={NOW} {...props} api={api} />
  );
  return { onOpenCourse, api };
}

const grid = () => screen.findByRole('group', { name: /^Semaine du/ });
/** Un événement de la grille (la liste des tâches a aussi un bouton par tâche). */
const block = async (name: RegExp) => within(await grid()).findByRole('button', { name });
const list = () => screen.findByRole('region', { name: 'Mes tâches de la semaine' });

/** Le bouton de la liste des types : « Type » suivi du type choisi. */
const typeButton = (panel: HTMLElement) => within(panel).getByRole('button', { name: /^Type / });
const typeMenu = (panel: HTMLElement) =>
  within(panel).getByRole('group', { name: 'Types de séance' });

/** Colonnes de 150 px côte à côte (jsdom n'a pas de mise en page) : mercredi = 450-600. */
function layoutColumns() {
  document.querySelectorAll<HTMLElement>('[class*="dayColumn"]').forEach((column, index) => {
    column.getBoundingClientRect = () =>
      ({ left: index * 150, right: (index + 1) * 150 }) as DOMRect;
  });
}

describe('SchedulePage — grille', () => {
  it('annonce le chargement, puis montre la semaine du dimanche au samedi et le jour courant', async () => {
    setup();
    expect(screen.getByRole('status').textContent).toContain('Chargement');
    expect(await grid()).toBeTruthy();
    expect(screen.getByText('Semaine du 25 au 31 octobre 2026')).toBeTruthy();
    expect(screen.getByText('Dim 25').className).toMatch(/weekend/);
    expect(screen.getByText('Mer 28').getAttribute('aria-current')).toBe('date');
    expect(screen.getByText('Lun 26').getAttribute('aria-current')).toBeNull();
    // Ligne bleue de l'heure courante, dans la colonne d'aujourd'hui.
    expect(document.querySelector('[class*="nowLine"]')?.parentElement).toBe(
      document.querySelectorAll('[class*="dayColumn"]')[3]
    );
  });

  it('une séance : sigle et type en pastille, puis local, puis heures, à sa place et dans sa couleur', async () => {
    setup();
    const session = await block(/^INF201/);
    expect(session.querySelector('[class*="kindTag"]')?.textContent).toBe('Cours');
    expect(session.textContent).toContain('C1-3125');
    expect(session.textContent).toContain('8 h 30 – 10 h 15');
    // Le nom accessible reprend le texte visible, puis le jour.
    expect(session.textContent).toContain('lundi 26 octobre');
    expect(session.style.top).toBe(`${8.5 * 4.375}rem`);
    expect(session.style.getPropertyValue('--hue')).toBe('174');
    expect((await block(/^MAT265/)).querySelector('[class*="kindTag"]')?.textContent).toBe('Labo');
  });

  it('les tâches : en cascade par-dessus la séance qu’elles chevauchent, avec l’heure et le cours lié', async () => {
    setup();
    const tutorat = await block(/^Tutorat/);
    expect(tutorat.textContent).toContain('14 h – 15 h');
    expect(tutorat.style.left).toBe('calc(1.5rem)');
    expect(tutorat.className).toMatch(/stacked/);
    // Recouvert après 30 minutes : le labo ne montre plus que son sigle.
    expect((await block(/^MAT265/)).className).toMatch(/titleOnly/);
    const lecture = await block(/^Lire le chapitre 4/);
    expect(lecture.textContent).toContain('9 h – 10 h · INF201');
    expect(lecture.textContent).toContain(', terminée');
  });

  it('passe d’une semaine à l’autre, et « Aujourd’hui » revient à la semaine en cours', async () => {
    setup();
    await block(/^INF201/);
    const today = screen.getByRole('button', { name: "Aujourd'hui" }) as HTMLButtonElement;
    expect(today.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
    expect(screen.getByText('Semaine du 1 au 7 novembre 2026')).toBeTruthy();
    await block(/^INF201/);
    expect(
      screen.queryByText((_, element) => element?.getAttribute('aria-current') === 'date')
    ).toBeNull();
    expect(document.querySelector('[class*="nowLine"]')).toBeNull();
    expect(today.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    expect(screen.getByText('Semaine du 18 au 24 octobre 2026')).toBeTruthy();

    fireEvent.click(today);
    expect(screen.getByText('Semaine du 25 au 31 octobre 2026')).toBeTruthy();
    await block(/^INF201/);
  });

  it('ignore une séance d’un cours inconnu', async () => {
    setup({
      api: makeApi({
        fetchSessions: vi.fn().mockResolvedValue([
          {
            id: 9,
            courseId: 99,
            kind: 'Cours',
            room: 'X',
            start: at(new Date(2026, 9, 25), 1, 9),
            end: at(new Date(2026, 9, 25), 1, 10),
          },
        ]),
        fetchTasks: vi.fn().mockResolvedValue([]),
      }),
    });
    expect(within(await grid()).queryByRole('button')).toBeNull();
  });

  it('une semaine vide le dit, sans cacher la grille ; sans cours, invite à en rejoindre un', async () => {
    const empty = {
      fetchSessions: vi.fn().mockResolvedValue([]),
      fetchTasks: vi.fn().mockResolvedValue([]),
    };
    setup({ api: makeApi(empty) });
    expect(await screen.findByText("Rien à l'horaire cette semaine.")).toBeTruthy();
    expect(await grid()).toBeTruthy();
    cleanup();
    setup({ courses: [], api: makeApi(empty) });
    expect(await screen.findByText('Rejoignez un cours pour voir votre horaire.')).toBeTruthy();
  });

  it('un échec de chargement propose de réessayer', async () => {
    const fetchTasks = vi
      .fn()
      .mockRejectedValueOnce(new Error('panne'))
      .mockImplementation(weeklyTasks);
    setup({ api: makeApi({ fetchTasks }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Réessayer' }));
    expect(await block(/^INF201/)).toBeTruthy();
    expect(fetchTasks).toHaveBeenCalledTimes(2);
  });

  it('ne recharge pas pour un nouveau tableau aux mêmes cours', async () => {
    const api = makeApi();
    const { rerender } = render(
      <SchedulePage courses={COURSES} api={api} onOpenCourse={vi.fn()} now={NOW} />
    );
    await block(/^INF201/);
    rerender(<SchedulePage courses={[...COURSES]} api={api} onOpenCourse={vi.fn()} now={NOW} />);
    await waitFor(() => expect(api.fetchSessions).toHaveBeenCalledTimes(1));
  });

  it('s’ouvre sur le premier événement, puis garde son défilement d’une semaine à l’autre', async () => {
    let scrolled = 0;
    const get = vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(() => scrolled);
    const set = vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(() => {});
    try {
      setup();
      await block(/^INF201/);
      // Premier événement à 8 h 30 : la grille s'ouvre sur 8 h (70 px par heure).
      expect(set).toHaveBeenLastCalledWith(8 * 70);
      scrolled = 900;
      fireEvent.scroll(document.querySelector('[class*="gridScroll"]')!);
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      await block(/^INF201/);
      expect(set).toHaveBeenLastCalledWith(900);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

describe('SchedulePage — petits blocs, description, tâches sans heure', () => {
  it('un petit bloc garde son titre et son heure ; la description prend la place qui reste', async () => {
    const fetchTasks = vi.fn(async (weekStart: Date) => [
      task({ id: 1, title: 'Appel', start: at(weekStart, 2, 9), end: at(weekStart, 2, 9, 15) }),
      task({ id: 2, title: 'Lecture', start: at(weekStart, 2, 11), end: at(weekStart, 2, 11, 45) }),
      task({
        id: 3,
        title: 'Projet',
        start: at(weekStart, 4, 9),
        end: at(weekStart, 4, 12),
        notes: 'Lire les pages 80 à 95',
      }),
    ]);
    setup({ api: makeApi({ fetchTasks }) });
    expect((await block(/^Appel/)).className).toMatch(/tiny/);
    expect((await block(/^Lecture/)).className).toMatch(/short/);
    expect((await block(/^Lecture/)).querySelector('[class*="blockDescription"]')).toBeNull();
    const description = (await block(/^Projet/)).querySelector<HTMLElement>(
      '[class*="blockDescription"]'
    )!;
    expect(description.textContent).toBe('Lire les pages 80 à 95');
    expect(description.style.webkitLineClamp).toBe('10');
  });

  it('les tâches sans heure flottent en haut de leur jour : deux, puis « +N de plus »', async () => {
    const fetchTasks = vi.fn(async (weekStart: Date) =>
      ['Remise A', 'Remise B', 'Remise C', 'Remise D'].map((title, i) =>
        task({
          id: 20 + i,
          title,
          start: at(weekStart, 4, 0),
          end: at(weekStart, 4, 0),
          allDay: true,
          done: i === 0,
        })
      )
    );
    setup({ api: makeApi({ fetchTasks }) });
    const chip = await block(/^Remise A/);
    expect(chip.textContent).toContain('jeudi 29 octobre, toute la journée, terminée');
    expect(within(await grid()).queryByRole('button', { name: /^Remise C/ })).toBeNull();
    const more = within(await grid()).getByRole('button', { name: '+2 de plus' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(await block(/^Remise D/)).toBeTruthy();
    fireEvent.click(within(await grid()).getByRole('button', { name: 'Voir moins' }));
    expect(within(await grid()).queryByRole('button', { name: /^Remise C/ })).toBeNull();
    expect(within(await list()).getAllByRole('listitem')[0].textContent).toBe(
      'Remise BJeu. 29 oct. · toute la journée'
    );

    fireEvent.click(chip);
    const dialog = screen.getByRole('dialog', { name: 'Modifier la tâche' });
    expect(
      (within(dialog).getByRole('checkbox', { name: 'Toute la journée' }) as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(within(dialog).queryByRole('combobox', { name: 'Début' })).toBeNull();
  });
});

describe('SchedulePage — remises', () => {
  it('une remise du cours : barre rouge à son heure, détails au survol, fenêtre en lecture', async () => {
    setup();
    const bar = await block(/Rapport de labo/);
    expect(bar.className).toMatch(/deadline/);
    expect(bar.style.top).toBe(`${17 * 4.375}rem`);
    expect(bar.querySelector('[class*="deadlineLabel"]')?.textContent).toBe(
      '17 hRemise : Rapport de labo'
    );
    expect(bar.querySelector('[class*="deadlineTip"]')?.textContent).toContain(
      'INF201 · Structures de données'
    );
    expect(bar.querySelector('[class*="deadlineTip"]')?.textContent).toContain('Format PDF');
    expect(within(await list()).getByText('Remise à 17 h')).toBeTruthy();

    fireEvent.click(bar);
    const dialog = screen.getByRole('dialog', { name: 'Remise : Rapport de labo' });
    expect(within(dialog).getByText('Mardi 27 octobre, 17 h 00')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Fermer' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('l’étudiant ajoute sa propre remise : une seule heure, en barre pendant la saisie', async () => {
    const { api } = setup();
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    const panel = screen.getByRole('complementary', { name: 'Ajouter une tâche' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Remise' }));
    expect(within(panel).queryByRole('checkbox', { name: 'Toute la journée' })).toBeNull();
    expect(within(panel).queryByRole('group', { name: 'Couleur' })).toBeNull();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Titre' }), {
      target: { value: 'Résumé' },
    });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Heure limite' }), {
      target: { value: '23:59' },
    });
    expect(document.querySelector('[class*="deadlinePreview"]')?.textContent).toBe(
      '23 h 59Remise : Résumé'
    );

    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la remise' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Ajouter une tâche' })).toBeNull()
    );
    const input = vi.mocked(api.createTask).mock.calls[0][0];
    expect(input).toMatchObject({
      title: 'Résumé',
      deadline: true,
      start: new Date(2026, 9, 28, 23, 59).toISOString(),
    });
    expect(input.end).toBe(input.start);
    // Sa remise à lui s'ouvre en modification.
    fireEvent.click(await block(/Résumé/));
    expect(screen.getByRole('dialog', { name: 'Modifier la tâche' })).toBeTruthy();
  });

  it('l’aperçu d’une remise se glisse pendant l’ajout ; le formulaire suit', async () => {
    setup();
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    const panel = screen.getByRole('complementary', { name: 'Ajouter une tâche' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Remise' }));
    layoutColumns();
    const preview = document.querySelector<HTMLElement>('[class*="deadlinePreview"]')!;
    // Mercredi 13 h ; vers jeudi, une heure plus tard.
    fireEvent.pointerDown(preview, { button: 0, clientX: 470, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 620, clientY: 570 });
    expect(document.querySelector('[class*="dropSpot"]')).toBeNull();
    fireEvent.pointerUp(window);
    expect((within(panel).getByLabelText('Date') as HTMLInputElement).value).toBe('2026-10-29');
    expect(
      (within(panel).getByRole('combobox', { name: 'Heure limite' }) as HTMLSelectElement).value
    ).toBe('14:00');
  });
});

describe('SchedulePage — détail d’une séance', () => {
  it('le sigle ouvre le cours, dans son programme', async () => {
    const { onOpenCourse } = setup();
    fireEvent.click(await block(/^INF201/));
    const dialog = screen.getByRole('dialog', { name: 'INF201 · Cours' });
    expect(within(dialog).getByText('Structures de données')).toBeTruthy();
    expect(within(dialog).getByText('Lundi 26 octobre, 8 h 30 à 10 h 15')).toBeTruthy();
    expect(within(dialog).getByText('C1-3125')).toBeTruthy();
    expect(within(dialog).queryByText('Répétition')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Voir le cours INF201' }));
    expect(onOpenCourse).toHaveBeenCalledWith(1, 10);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('une séance hebdomadaire dit sa répétition ; « Fermer » ferme', async () => {
    const fetchSessions = vi.fn(async (weekStart: Date) => [
      { ...(await weekly(weekStart))[1], until: new Date(2026, 11, 9).toISOString() },
    ]);
    setup({ api: makeApi({ fetchSessions }) });
    fireEvent.click(await block(/^MAT265/));
    const dialog = screen.getByRole('dialog', { name: 'MAT265 · Laboratoire' });
    expect(within(dialog).getByText("Chaque mercredi, jusqu'au 9 décembre")).toBeTruthy();
    // La croix de l'en-tête et le bouton du bas ferment tous deux.
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Fermer' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('choisir une couleur fait apparaître « Appliquer », qui l’enregistre ; un échec la remet', async () => {
    const setCourseColor = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('panne'));
    setup({
      api: makeApi({
        setCourseColor,
        fetchCourseColors: vi.fn().mockResolvedValue({ 11: 'green' }),
      }),
    });
    expect((await block(/^MAT265/)).style.getPropertyValue('--hue')).toBe('142');

    fireEvent.click(await block(/^INF201/));
    let dialog = screen.getByRole('dialog');
    const picker = within(dialog).getByRole('group', { name: 'Ma couleur pour ce cours' });
    expect(
      (within(picker).getByRole('radio', { name: 'Sarcelle' }) as HTMLInputElement).checked
    ).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'Appliquer' })).toBeNull();
    fireEvent.click(within(picker).getByRole('radio', { name: 'Violet' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Appliquer' }));
    expect(setCourseColor).toHaveBeenCalledWith(10, 'purple');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await block(/^INF201/)).style.getPropertyValue('--hue')).toBe('258');

    fireEvent.click(await block(/^INF201/));
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Rose' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Appliquer' }));
    await waitFor(async () =>
      expect((await block(/^INF201/)).style.getPropertyValue('--hue')).toBe('258')
    );
  });

  it('un échec au premier choix rend au cours sa couleur par défaut', async () => {
    setup({ api: makeApi({ setCourseColor: vi.fn().mockRejectedValue(new Error('panne')) }) });
    fireEvent.click(await block(/^INF201/));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Violet' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Appliquer' }));
    await waitFor(async () =>
      expect((await block(/^INF201/)).style.getPropertyValue('--hue')).toBe('174')
    );
  });
});

describe('SchedulePage — modifier une tâche', () => {
  it('un clic ouvre la fenêtre, remplie ; « Enregistrer » met la tâche à jour', async () => {
    const { api } = setup();
    fireEvent.click(await block(/^Lire le chapitre 4/));
    const dialog = screen.getByRole('dialog', { name: 'Modifier la tâche' });
    const title = within(dialog).getByRole('textbox', { name: 'Titre' }) as HTMLInputElement;
    expect(title.value).toBe('Lire le chapitre 4');
    expect((within(dialog).getByRole('radio', { name: 'Vert' }) as HTMLInputElement).checked).toBe(
      true
    );
    expect(
      (within(dialog).getByRole('checkbox', { name: 'Tâche terminée' }) as HTMLInputElement).checked
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole('combobox', {
          name: 'Cours lié (facultatif)',
        }) as HTMLSelectElement
      ).value
    ).toBe('10');
    expect(
      (within(dialog).getByRole('combobox', { name: 'Rappel' }) as HTMLSelectElement).value
    ).toBe('30');

    fireEvent.change(title, { target: { value: 'Lire le chapitre 5' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Violet' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Tâche terminée' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Cours lié (facultatif)' }), {
      target: { value: '' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Rappel' }), {
      target: { value: '' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Fin' }), {
      target: { value: '10:30' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Description' }), {
      target: { value: 'p. 95' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.updateTask).toHaveBeenCalledWith(
      8,
      expect.objectContaining({
        title: 'Lire le chapitre 5',
        color: 'purple',
        done: false,
        courseId: null,
        reminder: null,
        notes: 'p. 95',
      })
    );
    expect((await block(/^Lire le chapitre 5/)).textContent).toContain('9 h – 10 h 30');
  });

  it('refuse un titre vide, et dit quand l’enregistrement échoue', async () => {
    setup({ api: makeApi({ updateTask: vi.fn().mockRejectedValue(new Error('panne')) }) });
    fireEvent.click(await block(/^Tutorat/));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Titre' }), {
      target: { value: ' ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Donnez un titre à la tâche.');

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Titre' }), {
      target: { value: 'Tutorat' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "L'enregistrement a échoué. Réessayez."
    );
  });

  it('une tâche déplacée à une autre semaine quitte la grille', async () => {
    setup();
    fireEvent.click(await block(/^Tutorat/));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-11-04' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Tutorat/ })).toBeNull());
  });

  it('« Supprimer » retire la tâche ; « Annuler » et la croix ferment sans rien changer', async () => {
    const { api } = setup();
    fireEvent.click(await block(/^Tutorat/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(await block(/^Tutorat/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(await block(/^Tutorat/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Tutorat/ })).toBeNull());
    expect(api.deleteTask).toHaveBeenCalledWith(7);
    expect(api.updateTask).not.toHaveBeenCalled();
  });
});

describe('SchedulePage — ajouter (étudiant)', () => {
  it('le panneau remplace le bouton et la liste ; la tâche s’affiche pendant la saisie, puis s’ajoute', async () => {
    const { api } = setup();
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    expect(screen.queryByRole('button', { name: 'Ajouter une tâche' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Mes tâches de la semaine' })).toBeNull();
    const panel = screen.getByRole('complementary', { name: 'Ajouter une tâche' });
    expect(within(panel).getByRole('heading', { name: 'Nouvelle tâche' })).toBeTruthy();
    const title = within(panel).getByRole('textbox', { name: 'Titre' });
    expect(document.activeElement).toBe(title);

    // Aperçu : le jour courant, l'heure qui suit.
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la tâche' }));
    expect(within(panel).getByRole('alert').textContent).toBe('Donnez un titre à la tâche.');
    expect(screen.getByText('13 h – 14 h').closest('[aria-hidden]')?.textContent).toContain(
      'Nouvelle tâche'
    );
    fireEvent.change(title, { target: { value: 'Réviser l’intra' } });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Orange' }));
    expect(screen.getByText('Réviser l’intra').closest('[aria-hidden]')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la tâche' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Ajouter une tâche' })).toBeNull()
    );
    expect(api.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Réviser l’intra', color: 'orange', courseId: null })
    );
    expect(await block(/^Réviser l’intra/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    expect(await list()).toBeTruthy();
  });

  it('« Toute la journée » cache les heures ; une tâche d’une autre semaine ne s’affiche pas', async () => {
    const { api } = setup();
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    let panel = screen.getByRole('complementary', { name: 'Ajouter une tâche' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('complementary', { name: 'Ajouter une tâche' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    panel = screen.getByRole('complementary', { name: 'Ajouter une tâche' });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Titre' }), {
      target: { value: 'Plus tard' },
    });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Toute la journée' }));
    expect(within(panel).queryByRole('combobox', { name: 'Début' })).toBeNull();
    expect(screen.getByText('Plus tard').closest('[aria-hidden]')).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Date'), { target: { value: '2026-11-04' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la tâche' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Ajouter une tâche' })).toBeNull()
    );
    expect(api.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ allDay: true, start: new Date(2026, 10, 4).toISOString() })
    );
    expect(screen.queryByRole('button', { name: /^Plus tard/ })).toBeNull();
  });

  it('dit quand l’ajout échoue, et garde le panneau ouvert', async () => {
    setup({ api: makeApi({ createTask: vi.fn().mockRejectedValue(new Error('panne')) }) });
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    const panel = screen.getByRole('complementary', { name: 'Ajouter une tâche' });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Titre' }), {
      target: { value: 'Lire' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la tâche' }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(
      "L'ajout a échoué. Réessayez."
    );
  });

  it('glisser l’aperçu change le jour et les heures ; l’allonger change la fin', async () => {
    setup();
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    layoutColumns();
    const preview = () => document.querySelector<HTMLElement>('[class*="preview"]')!;
    // Mercredi 13 h – 14 h ; vers jeudi, une heure plus tard.
    fireEvent.pointerDown(preview(), { button: 0, clientX: 470, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 620, clientY: 570 });
    expect(preview().textContent).toContain('14 h – 15 h');
    expect(preview().className).toMatch(/dragging/);
    fireEvent.pointerUp(window);
    const panel = screen.getByRole('complementary', { name: 'Ajouter une tâche' });
    expect((within(panel).getByLabelText('Date') as HTMLInputElement).value).toBe('2026-10-29');
    expect(
      (within(panel).getByRole('combobox', { name: 'Début' }) as HTMLSelectElement).value
    ).toBe('14:00');
    expect((within(panel).getByRole('combobox', { name: 'Fin' }) as HTMLSelectElement).value).toBe(
      '15:00'
    );

    fireEvent.pointerDown(preview().querySelector('[class*="resizeHandle"]')!, {
      button: 0,
      clientX: 620,
      clientY: 570,
    });
    fireEvent.pointerMove(window, { clientX: 620, clientY: 605 });
    fireEvent.pointerUp(window);
    expect((within(panel).getByRole('combobox', { name: 'Fin' }) as HTMLSelectElement).value).toBe(
      '15:30'
    );
  });
});

describe('SchedulePage — enseignant', () => {
  it('ne voit ni tâches personnelles ni « Mes tâches » ; voit les remises de ses cours', async () => {
    setup({ courses: TEACHER });
    await block(/^INF201/);
    expect(within(await grid()).queryByRole('button', { name: /^Tutorat/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Mes tâches de la semaine' })).toBeNull();
    expect(await block(/Rapport de labo/)).toBeTruthy();
  });

  it('ajoute une séance à son cours, chaque semaine jusqu’à une date, d’un type à lui', async () => {
    const { api } = setup({ courses: TEACHER });
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: "Ajouter à l'horaire" }));
    const panel = screen.getByRole('complementary', { name: "Ajouter à l'horaire" });
    expect(within(panel).queryByRole('textbox', { name: 'Titre' })).toBeNull();
    // Seuls les cours qu'il gère.
    const course = within(panel).getByRole('button', { name: 'Cours MAT265' });
    fireEvent.click(course);
    const courses = within(panel).getByRole('group', { name: 'Mes cours' });
    expect(
      within(courses)
        .getAllByRole('button')
        .map((o) => o.textContent)
    ).toEqual(['MAT265']);
    fireEvent.click(within(courses).getByRole('button', { name: 'MAT265' }));
    expect(screen.queryByRole('group', { name: 'Mes cours' })).toBeNull();

    // « Ajouter un type… » change la liste en champ ; Entrée l'ajoute et le sélectionne.
    expect(typeButton(panel).textContent).toBe('Cours');
    fireEvent.click(typeButton(panel));
    expect(typeButton(panel).getAttribute('aria-expanded')).toBe('true');
    // Le focus va au type choisi.
    expect(document.activeElement).toBe(
      within(typeMenu(panel)).getByRole('button', { name: 'Cours' })
    );
    fireEvent.click(within(typeMenu(panel)).getByRole('button', { name: '＋ Ajouter un type…' }));
    const newType = within(panel).getByRole('textbox', { name: 'Type' });
    expect(document.activeElement).toBe(newType);
    fireEvent.change(newType, { target: { value: 'Séminaire' } });
    fireEvent.keyDown(newType, { key: 'Enter' });
    expect(typeButton(panel).textContent).toBe('Séminaire');
    fireEvent.click(typeButton(panel));
    expect(
      within(typeMenu(panel))
        .getByRole('button', { name: 'Séminaire' })
        .getAttribute('aria-pressed')
    ).toBe('true');
    fireEvent.keyDown(typeMenu(panel), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Types de séance' })).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la séance' }));
    expect(within(panel).getByRole('alert').textContent).toBe('Indiquez le local.');
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Local' }), {
      target: { value: 'C1-4016' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Chaque semaine' }));
    const until = within(panel).getByLabelText("Jusqu'au") as HTMLInputElement;
    expect(until.value).toBe('2026-10-28');
    fireEvent.change(until, { target: { value: '2026-12-09' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la séance' }));

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: "Ajouter à l'horaire" })).toBeNull()
    );
    expect(api.createSessions).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: 11, kind: 'Séminaire', room: 'C1-4016' })
    );
    expect(vi.mocked(api.createSessions).mock.calls[0][0].until).toBe(
      new Date(2026, 11, 9).toISOString()
    );
    expect(
      (await block(/^MAT265 ?Séminaire/)).querySelector('[class*="kindTag"]')?.textContent
    ).toBe('Séminaire');
  });

  it('un type déjà connu est repris, Échap revient à la liste, « Une fois » retire la répétition', async () => {
    setup({ courses: TEACHER });
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: "Ajouter à l'horaire" }));
    const panel = screen.getByRole('complementary', { name: "Ajouter à l'horaire" });
    fireEvent.click(typeButton(panel));
    fireEvent.click(within(typeMenu(panel)).getByRole('button', { name: '＋ Ajouter un type…' }));
    fireEvent.keyDown(within(panel).getByRole('textbox', { name: 'Type' }), { key: 'Escape' });
    expect(typeButton(panel)).toBeTruthy();

    // Un type déjà dans la liste est repris tel quel, sans doublon.
    fireEvent.click(typeButton(panel));
    fireEvent.click(within(typeMenu(panel)).getByRole('button', { name: '＋ Ajouter un type…' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Type' }), {
      target: { value: 'atelier' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter' }));
    expect(typeButton(panel).textContent).toBe('Atelier');
    fireEvent.click(typeButton(panel));
    expect(
      within(typeMenu(panel)).getAllByRole('button', { name: /^Supprimer le type « Atelier »/ })
    ).toHaveLength(1);
    // Les flèches passent d'un type à l'autre ; choisir referme la liste.
    fireEvent.keyDown(typeMenu(panel), { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Tutorat');
    fireEvent.keyDown(typeMenu(panel), { key: 'ArrowUp' });
    fireEvent.keyDown(typeMenu(panel), { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('Laboratoire');
    fireEvent.click(within(typeMenu(panel)).getByRole('button', { name: 'Laboratoire' }));
    expect(typeButton(panel).textContent).toBe('Laboratoire');
    expect(document.activeElement).toBe(typeButton(panel));

    fireEvent.click(within(panel).getByRole('button', { name: 'Chaque semaine' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Une fois' }));
    expect(within(panel).queryByLabelText("Jusqu'au")).toBeNull();
  });
});

describe('SchedulePage — types de séance ajoutés', () => {
  it('chaque type a sa corbeille ; supprimer le type choisi passe au suivant ; un clic ailleurs ferme', async () => {
    setup({ courses: TEACHER });
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: "Ajouter à l'horaire" }));
    const panel = screen.getByRole('complementary', { name: "Ajouter à l'horaire" });
    fireEvent.click(typeButton(panel));
    fireEvent.click(within(typeMenu(panel)).getByRole('button', { name: '＋ Ajouter un type…' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Type' }), {
      target: { value: 'Examen' },
    });
    fireEvent.keyDown(within(panel).getByRole('textbox', { name: 'Type' }), { key: 'Enter' });

    fireEvent.click(typeButton(panel));
    fireEvent.click(
      within(typeMenu(panel)).getByRole('button', { name: 'Supprimer le type « Examen »' })
    );
    expect(within(typeMenu(panel)).queryByRole('button', { name: 'Examen' })).toBeNull();
    expect(typeButton(panel).textContent).toBe('Cours');
    // Les types de base aussi se suppriment : le suivant prend la place du type choisi.
    fireEvent.click(
      within(typeMenu(panel)).getByRole('button', { name: 'Supprimer le type « Cours »' })
    );
    expect(typeButton(panel).textContent).toBe('Travaux dirigés');
    // La liste reste ouverte après une suppression ; un clic ailleurs la ferme.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('group', { name: 'Types de séance' })).toBeNull();
  });

  it('la liste vidée, la séance demande un type ; un nouvel ajout repart du premier type restant', async () => {
    setup({ courses: TEACHER });
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: "Ajouter à l'horaire" }));
    let panel = screen.getByRole('complementary', { name: "Ajouter à l'horaire" });
    fireEvent.click(typeButton(panel));
    for (const kind of ['Cours', 'Travaux dirigés', 'Laboratoire', 'Atelier', 'Tutorat']) {
      fireEvent.click(
        within(typeMenu(panel)).getByRole('button', { name: `Supprimer le type « ${kind} »` })
      );
    }
    expect(typeButton(panel).textContent).toBe('Choisir un type');
    fireEvent.keyDown(typeMenu(panel), { key: 'Escape' });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Local' }), {
      target: { value: 'A1' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la séance' }));
    expect(within(panel).getByRole('alert').textContent).toBe('Choisissez un type de séance.');

    fireEvent.click(typeButton(panel));
    fireEvent.click(within(typeMenu(panel)).getByRole('button', { name: '＋ Ajouter un type…' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Type' }), {
      target: { value: 'Examen' },
    });
    fireEvent.keyDown(within(panel).getByRole('textbox', { name: 'Type' }), { key: 'Enter' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Annuler' }));
    fireEvent.click(screen.getByRole('button', { name: "Ajouter à l'horaire" }));
    panel = screen.getByRole('complementary', { name: "Ajouter à l'horaire" });
    expect(typeButton(panel).textContent).toBe('Examen');
  });
});

describe('SchedulePage — glisser une tâche', () => {
  const dropSpot = () => document.querySelector('[class*="dropSpot"]');

  it('le bloc suit le pointeur et montre l’heure d’arrivée ; l’ombre montre où il tombera', async () => {
    const { api } = setup();
    const tutorat = await block(/^Tutorat/);
    layoutColumns();
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 470, clientY: 500 });
    // 70 px font une heure ; de mercredi (450-600) à jeudi (600-750).
    fireEvent.pointerMove(window, { clientX: 620, clientY: 540 });
    fireEvent.pointerMove(window, { clientX: 620, clientY: 570 });
    const moving = await block(/^Tutorat/);
    expect(moving.className).toMatch(/dragging/);
    expect(moving.style.transform).toBe('translate(150px, 70px)');
    expect(moving.textContent).toContain('15 h – 16 h');
    expect(dropSpot()?.parentElement).toBe(document.querySelectorAll('[class*="dayColumn"]')[4]);
    fireEvent.pointerUp(window);
    expect(dropSpot()).toBeNull();
    // Le clic arrive dans la même tâche du navigateur que le pointerup : sans attente.
    fireEvent.click(
      within(screen.getByRole('group', { name: /^Semaine du/ })).getByRole('button', {
        name: /^Tutorat/,
      })
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.updateTask).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        start: new Date(2026, 9, 29, 15).toISOString(),
        end: new Date(2026, 9, 29, 16).toISOString(),
      })
    );
    // Le geste fini, un clic ouvre la tâche de nouveau.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(await block(/^Tutorat/));
    expect(screen.getByRole('dialog', { name: 'Modifier la tâche' })).toBeTruthy();
  });

  it('le bloc ne quitte pas la grille', async () => {
    setup();
    const tutorat = await block(/^Tutorat/);
    layoutColumns();
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 470, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 3000, clientY: -5000 });
    // Jusqu'au bord droit (sept colonnes, 1050 px) et jusqu'à 0 h, pas plus loin.
    expect((await block(/^Tutorat/)).style.transform).toMatch(
      /^translate\(1050px, -980(\.0+\d*)?px\)$/
    );
    expect((await block(/^Tutorat/)).textContent).toContain('0 h – 1 h');
    fireEvent.pointerUp(window);
  });

  it('l’allonger montre déjà sa hauteur d’arrivée, sans ombre ni changement de jour', async () => {
    const { api } = setup();
    const tutorat = await block(/^Tutorat/);
    layoutColumns();
    fireEvent.pointerDown(tutorat.querySelector('[class*="resizeHandle"]')!, {
      button: 0,
      clientX: 470,
      clientY: 570,
    });
    fireEvent.pointerMove(window, { clientX: 900, clientY: 605 });
    expect((await block(/^Tutorat/)).style.height).toBe(`${1.5 * 4.375}rem`);
    expect(dropSpot()).toBeNull();
    fireEvent.pointerUp(window);
    expect(api.updateTask).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ end: new Date(2026, 9, 28, 15, 30).toISOString() })
    );
  });

  it('un petit tremblement reste un clic ; le bouton droit ne glisse pas ; un échec remet la tâche', async () => {
    const { api } = setup({
      api: makeApi({ updateTask: vi.fn().mockRejectedValue(new Error('panne')) }),
    });
    const tutorat = await block(/^Tutorat/);
    layoutColumns();
    fireEvent.pointerDown(tutorat, { button: 2, clientX: 470, clientY: 500 });
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 470, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 472, clientY: 502 });
    fireEvent.pointerUp(window);
    expect(api.updateTask).not.toHaveBeenCalled();

    // Ramené à son point de départ : rien à enregistrer.
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 470, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 520 });
    fireEvent.pointerMove(window, { clientX: 470, clientY: 500 });
    fireEvent.pointerUp(window);
    expect(api.updateTask).not.toHaveBeenCalled();

    fireEvent.pointerDown(tutorat, { button: 0, clientX: 470, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 470, clientY: 640 });
    fireEvent.pointerUp(window);
    expect(api.updateTask).toHaveBeenCalledTimes(1);
    await waitFor(async () =>
      expect((await block(/^Tutorat/)).textContent).toContain('14 h – 15 h,')
    );
  });

  it('près du bord de la grille, la grille défile avec la tâche, sans aller trop vite', async () => {
    setup();
    const tutorat = await block(/^Tutorat/);
    layoutColumns();
    const scroller = document.querySelector<HTMLElement>('[class*="gridScroll"]')!;
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 470, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 470, clientY: 590 });
    frames.shift()!(0);
    expect(scrollTop).toBeGreaterThan(0);
    expect(scrollTop).toBeLessThanOrEqual(8);
    fireEvent.pointerUp(window);
    raf.mockRestore();
  });
});

describe('SchedulePage — liste des tâches', () => {
  it('liste les tâches à faire de la semaine, dans l’ordre, avec la remise mise en évidence', async () => {
    setup();
    const items = within(await list()).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Rapport de laboMar. 27 oct. · Remise à 17 h',
      'TutoratMer. 28 oct. · 14 h – 15 h',
    ]);
    expect(items[0].className).toMatch(/deadlineItem/);
    fireEvent.click(within(await list()).getByRole('button', { name: /^Tutorat/ }));
    expect(screen.getByRole('dialog', { name: 'Modifier la tâche' })).toBeTruthy();
  });

  it('cocher une tâche : « terminée · Annuler » à sa place ; « Annuler » la remet', async () => {
    const { api } = setup();
    fireEvent.click(within(await list()).getByRole('checkbox', { name: 'Tutorat : terminée' }));
    expect(api.updateTask).toHaveBeenCalledWith(7, expect.objectContaining({ done: true }));
    expect((await block(/^Tutorat/)).className).toMatch(/done/);
    expect(within(await list()).getByRole('status').textContent).toBe('« Tutorat » terminée');
    fireEvent.click(
      within(await list()).getByRole('button', { name: 'Annuler : remettre « Tutorat » à faire' })
    );
    expect(api.updateTask).toHaveBeenLastCalledWith(7, expect.objectContaining({ done: false }));
    expect(within(await list()).getByRole('checkbox', { name: 'Tutorat : terminée' })).toBeTruthy();
  });

  it('sans « Annuler », la ligne quitte la liste après quelques secondes', async () => {
    setup();
    const box = within(await list()).getByRole('checkbox', { name: 'Tutorat : terminée' });
    vi.useFakeTimers();
    fireEvent.click(box);
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(
      within(screen.getByRole('region', { name: 'Mes tâches de la semaine' })).queryByText(
        /Tutorat/
      )
    ).toBeNull();
  });

  it('tout fait, la liste le dit ; sans tâche aussi', async () => {
    setup({
      api: makeApi({
        fetchTasks: vi.fn(async (weekStart: Date) => [(await weeklyTasks(weekStart))[1]]),
      }),
    });
    expect(await screen.findByText('Tout est fait pour cette semaine.')).toBeTruthy();
    cleanup();
    setup({ api: makeApi({ fetchTasks: vi.fn().mockResolvedValue([]) }) });
    expect(await screen.findByText('Aucune tâche cette semaine.')).toBeTruthy();
  });

  it('la corbeille supprime la tâche ; un échec la garde', async () => {
    const deleteTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('panne'))
      .mockResolvedValue(undefined);
    setup({ api: makeApi({ deleteTask }) });
    fireEvent.click(within(await list()).getByRole('button', { name: 'Supprimer « Tutorat »' }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1));
    expect(await block(/^Tutorat/)).toBeTruthy();
    fireEvent.click(within(await list()).getByRole('button', { name: 'Supprimer « Tutorat »' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Tutorat/ })).toBeNull());
  });
});

describe('SchedulePage — mobile', () => {
  it('une liste par jour, séances, tâches et remises, sans les jours vides, le jour courant marqué', async () => {
    setup({ compact: true });
    const monday = await screen.findByRole('region', { name: 'lundi 26 octobre' });
    expect(within(monday).getByRole('heading', { name: 'Lundi 26 octobre' })).toBeTruthy();
    expect(within(monday).getByRole('button', { name: /^INF201/ })).toBeTruthy();
    const tuesday = screen.getByRole('region', { name: 'mardi 27 octobre' });
    expect(within(tuesday).getByRole('button', { name: /^Rapport de labo/ }).textContent).toContain(
      'Remise à 17 h'
    );

    const wednesday = screen.getByRole('region', { name: 'mercredi 28 octobre' });
    expect(within(wednesday).getByText("Aujourd'hui")).toBeTruthy();
    expect(
      within(wednesday)
        .getAllByRole('button')
        .map((b) => b.textContent?.slice(0, 6))
    ).toEqual(['MAT265', 'Tutora']);
    expect(screen.queryByRole('region', { name: 'dimanche 25 octobre' })).toBeNull();
    expect(screen.queryByRole('group', { name: /^Semaine du/ })).toBeNull();
  });

  it('une semaine vide le dit', async () => {
    setup({
      compact: true,
      api: makeApi({
        fetchSessions: vi.fn().mockResolvedValue([]),
        fetchTasks: vi.fn().mockResolvedValue([]),
      }),
    });
    expect(await screen.findByText("Rien à l'horaire cette semaine.")).toBeTruthy();
  });

  it('l’ajout s’ouvre dans une fenêtre, que la croix referme', async () => {
    setup({ compact: true });
    await screen.findByRole('region', { name: 'lundi 26 octobre' });
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    const dialog = screen.getByRole('dialog', { name: 'Ajouter une tâche' });
    expect(within(dialog).getByRole('textbox', { name: 'Titre' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Ajouter une tâche' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
