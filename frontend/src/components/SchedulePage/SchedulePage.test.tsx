import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SchedulePage, { type ScheduleApi } from './SchedulePage';
import type {
  ScheduleColor,
  ScheduleCourse,
  ScheduleSession,
  ScheduleTask,
} from '../../types/domain';

// jsdom ne fournit pas matchMedia ; reduced-motion → les fenêtres se ferment sans animation.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

afterEach(cleanup);

/** Mercredi 28 octobre 2026 : la semaine du 26 au 30 octobre. */
const NOW = new Date(2026, 9, 28, 12, 0);
const COURSES: ScheduleCourse[] = [
  { id: 10, code: 'INF201', title: 'Structures de données', programId: 1 },
  { id: 11, code: 'MAT265', programId: 2 },
];
const TEACHER: ScheduleCourse[] = [COURSES[0], { ...COURSES[1], canManage: true }];

const at = (week: Date, day: number, hour: number, minute = 0) => {
  const date = new Date(week);
  date.setDate(date.getDate() + day);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

/** Deux séances par semaine, aux mêmes jours que la semaine demandée. */
const weekly = async (weekStart: Date): Promise<ScheduleSession[]> => [
  {
    id: 1,
    courseId: 10,
    kind: 'Cours',
    room: 'C1-3125',
    start: at(weekStart, 0, 8, 30),
    end: at(weekStart, 0, 10, 15),
  },
  {
    id: 2,
    courseId: 11,
    kind: 'Laboratoire',
    room: 'D7-2021',
    start: at(weekStart, 2, 13, 30),
    end: at(weekStart, 2, 15, 15),
  },
];

/** Une tâche le mercredi, par-dessus le laboratoire de MAT265, et une liée à INF201 le vendredi. */
const weeklyTasks = async (weekStart: Date): Promise<ScheduleTask[]> => [
  {
    id: 7,
    title: 'Tutorat',
    start: at(weekStart, 2, 14),
    end: at(weekStart, 2, 15),
    courseId: null,
    reminder: null,
    notes: '',
    color: 'rose',
    done: false,
    allDay: false,
  },
  {
    id: 8,
    title: 'Lire le chapitre 4',
    start: at(weekStart, 4, 9),
    end: at(weekStart, 4, 10),
    courseId: 10,
    reminder: 30,
    notes: 'p. 80',
    color: 'green',
    done: true,
    allDay: false,
  },
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

/** Un événement de la grille (la liste des tâches a aussi un bouton par tâche). */
const block = async (name: RegExp) =>
  within(await screen.findByRole('group', { name: /^Semaine du/ })).findByRole('button', { name });

describe('SchedulePage — grille', () => {
  it('annonce le chargement, puis montre la semaine et le jour courant', async () => {
    setup();
    expect(screen.getByRole('status').textContent).toContain('Chargement');
    expect(
      await screen.findByRole('group', { name: 'Semaine du 26 au 30 octobre 2026' })
    ).toBeTruthy();
    expect(screen.getByText('Mer 28').getAttribute('aria-current')).toBe('date');
    expect(screen.getByText('Lun 26').getAttribute('aria-current')).toBeNull();
  });

  it('montre chaque séance avec son cours, son type, son local, ses heures et sa couleur', async () => {
    setup();
    const session = await block(/^INF201/);
    expect(session.textContent).toContain('Cours · C1-3125');
    expect(session.textContent).toContain('8 h 30 à 10 h 15');
    // Le nom accessible reprend le texte visible, puis le jour.
    expect(session.textContent).toContain('lundi 26 octobre');
    expect(session.style.top).toBe(`${8.5 * 4.375}rem`);
    expect(session.style.getPropertyValue('--hue')).toBe('174');
  });

  it('montre les tâches, en cascade par-dessus la séance qu’elles chevauchent', async () => {
    setup();
    const tutorat = await block(/^Tutorat/);
    // L'heure en court : « 14 h – 15 h » ; le cours lié, s'il y en a un, à la suite.
    expect(tutorat.textContent).toContain('14 h – 15 h');
    expect(tutorat.textContent).not.toContain('Tâche personnelle');
    expect(tutorat.style.left).toBe('calc(1.5rem)');
    expect(tutorat.className).toMatch(/stacked/);
    // Recouvert après 30 minutes : le laboratoire ne montre plus que son sigle.
    expect((await block(/^MAT265/)).className).toMatch(/titleOnly/);
    expect((await block(/^Lire le chapitre 4/)).textContent).toContain('INF201');
  });

  it('passe d’une semaine à l’autre, et « Aujourd’hui » revient à la semaine en cours', async () => {
    setup();
    await block(/^INF201/);
    const today = screen.getByRole('button', { name: "Aujourd'hui" }) as HTMLButtonElement;
    expect(today.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
    expect(screen.getByText('Semaine du 2 au 6 novembre 2026')).toBeTruthy();
    await block(/^INF201/);
    expect(
      screen.queryByText((_, element) => element?.getAttribute('aria-current') === 'date')
    ).toBeNull();
    expect(today.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    expect(screen.getByText('Semaine du 19 au 23 octobre 2026')).toBeTruthy();

    fireEvent.click(today);
    expect(screen.getByText('Semaine du 26 au 30 octobre 2026')).toBeTruthy();
    await block(/^INF201/);
  });

  it('ignore une séance d’un cours inconnu', async () => {
    const api = makeApi({
      fetchSessions: vi.fn().mockResolvedValue([
        {
          id: 9,
          courseId: 99,
          kind: 'Cours',
          room: 'X',
          start: at(new Date(2026, 9, 26), 0, 9),
          end: at(new Date(2026, 9, 26), 0, 10),
        },
      ]),
      fetchTasks: vi.fn().mockResolvedValue([]),
    });
    setup({ api });
    await screen.findByRole('group');
    expect(screen.queryByRole('button', { name: /Cours/ })).toBeNull();
  });

  it('une semaine vide le dit, sans cacher la grille', async () => {
    setup({
      api: makeApi({
        fetchSessions: vi.fn().mockResolvedValue([]),
        fetchTasks: vi.fn().mockResolvedValue([]),
      }),
    });
    expect(await screen.findByText("Rien à l'horaire cette semaine.")).toBeTruthy();
    expect(screen.getByRole('group')).toBeTruthy();
  });

  it('sans cours ni tâche, invite à rejoindre un cours', async () => {
    setup({
      courses: [],
      api: makeApi({
        fetchSessions: vi.fn().mockResolvedValue([]),
        fetchTasks: vi.fn().mockResolvedValue([]),
      }),
    });
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
});

describe('SchedulePage — détail d’une séance', () => {
  it('un clic montre la séance ; « Voir le cours » ouvre le cours, dans son programme', async () => {
    const { onOpenCourse } = setup();
    fireEvent.click(await block(/^INF201/));
    const dialog = screen.getByRole('dialog', { name: 'INF201 · Cours' });
    expect(within(dialog).getByText('Structures de données')).toBeTruthy();
    expect(within(dialog).getByText('Lundi 26 octobre, 8 h 30 à 10 h 15')).toBeTruthy();
    expect(within(dialog).getByText('C1-3125')).toBeTruthy();
    expect(within(dialog).queryByText('Répétition')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Voir le cours' }));
    expect(onOpenCourse).toHaveBeenCalledWith(1, 10);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('une séance hebdomadaire dit sa répétition', async () => {
    const fetchSessions = vi.fn(async (weekStart: Date) => [
      { ...(await weekly(weekStart))[1], until: new Date(2026, 11, 9).toISOString() },
    ]);
    setup({ courses: TEACHER, api: makeApi({ fetchSessions }) });
    fireEvent.click(await block(/^MAT265/));
    const dialog = screen.getByRole('dialog', { name: 'MAT265 · Laboratoire' });
    expect(within(dialog).getByText("Chaque mercredi, jusqu'au 9 décembre")).toBeTruthy();
    // La croix de l'en-tête et le bouton du bas ferment tous deux.
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Fermer' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
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
    expect(screen.getByRole('dialog')).toBeTruthy();
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

describe('SchedulePage — ajouter', () => {
  it('« Ajouter une tâche » ouvre le panneau ; la tâche s’affiche pendant la saisie, puis s’ajoute', async () => {
    const { api } = setup();
    await block(/^INF201/);
    const open = screen.getByRole('button', { name: 'Ajouter une tâche' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('complementary', { name: 'Ajouter une tâche' });
    expect(within(panel).getByRole('heading', { name: 'Nouvelle tâche' })).toBeTruthy();
    expect(within(panel).queryByRole('group', { name: "Type d'ajout" })).toBeNull();
    const title = within(panel).getByRole('textbox', { name: 'Titre' });
    expect(document.activeElement).toBe(title);
    // Le formulaire prend toute la colonne : la liste des tâches revient à la fermeture.
    expect(screen.queryByRole('region', { name: 'Mes tâches de la semaine' })).toBeNull();

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
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(screen.getByRole('region', { name: 'Mes tâches de la semaine' })).toBeTruthy();
    expect(api.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Réviser l’intra', color: 'orange', courseId: null })
    );
    expect(await block(/^Réviser l’intra/)).toBeTruthy();
    expect(document.activeElement).toBe(open);
  });

  it('le bouton ou « Annuler » referme le panneau ; une tâche d’une autre semaine ne s’affiche pas', async () => {
    setup();
    await block(/^INF201/);
    const open = screen.getByRole('button', { name: 'Ajouter une tâche' });
    fireEvent.click(open);
    fireEvent.click(open);
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(open);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('complementary')).toBeNull();

    fireEvent.click(open);
    const panel = screen.getByRole('complementary');
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Titre' }), {
      target: { value: 'Plus tard' },
    });
    fireEvent.change(within(panel).getByLabelText('Date'), { target: { value: '2026-11-04' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la tâche' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(screen.queryByRole('button', { name: /^Plus tard/ })).toBeNull();
  });

  it('dit quand l’ajout échoue, et garde le panneau ouvert', async () => {
    setup({ api: makeApi({ createTask: vi.fn().mockRejectedValue(new Error('panne')) }) });
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    const panel = screen.getByRole('complementary');
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Titre' }), {
      target: { value: 'Lire' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la tâche' }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(
      "L'ajout a échoué. Réessayez."
    );
  });

  it('l’enseignant ajoute une séance à son cours, chaque semaine jusqu’à une date', async () => {
    const { api } = setup({ courses: TEACHER });
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: "Ajouter à l'horaire" }));
    const panel = screen.getByRole('complementary', { name: "Ajouter à l'horaire" });
    fireEvent.click(within(panel).getByRole('button', { name: 'Séance du cours' }));
    expect(
      within(panel).getByRole('button', { name: 'Séance du cours' }).getAttribute('aria-pressed')
    ).toBe('true');
    // Seuls les cours qu'il gère.
    const course = within(panel).getByRole('combobox', { name: 'Cours' }) as HTMLSelectElement;
    expect([...course.options].map((o) => o.textContent)).toEqual(['MAT265']);
    fireEvent.change(course, { target: { value: '11' } });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Type' }), {
      target: { value: 'Atelier' },
    });
    expect(document.querySelector('[class*="preview"]')?.textContent).toContain('MAT265');

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

    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(api.createSessions).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: 11, kind: 'Atelier', room: 'C1-4016' })
    );
    expect(vi.mocked(api.createSessions).mock.calls[0][0].until).toBe(
      new Date(2026, 11, 9).toISOString()
    );
    expect(await block(/^MAT265 ?Atelier/)).toBeTruthy();
  });

  it('« Une fois » retire la répétition ; revenir à « Tâche » oublie le cours de la séance', async () => {
    setup({ courses: TEACHER });
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: "Ajouter à l'horaire" }));
    const panel = screen.getByRole('complementary');
    fireEvent.click(within(panel).getByRole('button', { name: 'Tâche' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Séance du cours' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Chaque semaine' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Une fois' }));
    expect(within(panel).queryByLabelText("Jusqu'au")).toBeNull();
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Début' }), {
      target: { value: '08:00' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Tâche' }));
    expect(
      (within(panel).getByRole('combobox', { name: 'Cours lié (facultatif)' }) as HTMLSelectElement)
        .value
    ).toBe('');
  });
});

describe('SchedulePage — mobile', () => {
  it('une liste par jour, séances et tâches, sans les jours vides, avec le jour courant marqué', async () => {
    setup({ compact: true });
    const monday = await screen.findByRole('region', { name: 'lundi 26 octobre' });
    expect(within(monday).getByRole('heading', { name: 'Lundi 26 octobre' })).toBeTruthy();
    expect(within(monday).getByRole('button', { name: /^INF201/ })).toBeTruthy();

    const wednesday = screen.getByRole('region', { name: 'mercredi 28 octobre' });
    expect(within(wednesday).getByText("Aujourd'hui")).toBeTruthy();
    expect(
      within(wednesday)
        .getAllByRole('button')
        .map((b) => b.textContent?.slice(0, 6))
    ).toEqual(['MAT265', 'Tutora']);
    expect(screen.queryByRole('region', { name: 'mardi 27 octobre' })).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
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
    const open = screen.getByRole('button', { name: 'Ajouter une tâche' });
    expect(open.getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(open);
    const dialog = screen.getByRole('dialog', { name: 'Ajouter une tâche' });
    expect(within(dialog).getByRole('textbox', { name: 'Titre' })).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SchedulePage — glisser une tâche', () => {
  /** Colonnes de 150 px côte à côte (jsdom n'a pas de mise en page). */
  function layoutColumns() {
    document.querySelectorAll<HTMLElement>('[class*="dayColumn"]').forEach((column, index) => {
      column.getBoundingClientRect = () =>
        ({ left: index * 150, right: (index + 1) * 150 }) as DOMRect;
    });
  }

  const dropSpot = () => document.querySelector('[class*="dropSpot"]');

  it('le bloc suit le pointeur ; l’emplacement montre où il tombera ; le clic qui suit n’ouvre rien', async () => {
    const { api } = setup();
    const tutorat = await block(/^Tutorat/);
    layoutColumns();
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 320, clientY: 500 });
    // 70 px font une heure ; de mercredi (300-450) à jeudi (450-600).
    fireEvent.pointerMove(window, { clientX: 470, clientY: 540 });
    fireEvent.pointerMove(window, { clientX: 470, clientY: 570 });
    const moving = await block(/^Tutorat/);
    expect(moving.className).toMatch(/dragging/);
    expect(moving.style.transform).toBe('translate(150px, 70px)');
    expect(dropSpot()?.textContent).toBe('');
    expect(moving.textContent).toContain('15 h – 16 h');
    expect(dropSpot()?.parentElement).toBe(document.querySelectorAll('[class*="dayColumn"]')[3]);
    fireEvent.pointerUp(window);
    expect(dropSpot()).toBeNull();
    // Le clic arrive dans la même tâche du navigateur que le pointerup : sans attente.
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: /^Tutorat/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.updateTask).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        title: 'Tutorat',
        start: new Date(2026, 9, 29, 15).toISOString(),
        end: new Date(2026, 9, 29, 16).toISOString(),
      })
    );
    expect((await block(/^Tutorat/)).textContent).toContain('15 h – 16 h, jeudi 29 octobre');
    // Le geste fini, un clic ouvre la tâche de nouveau.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(await block(/^Tutorat/));
    expect(screen.getByRole('dialog', { name: 'Modifier la tâche' })).toBeTruthy();
  });

  it('le bloc ne quitte pas la grille', async () => {
    setup();
    const tutorat = await block(/^Tutorat/);
    layoutColumns();
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 320, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 2000, clientY: -5000 });
    // Jusqu'au bord droit (750 px) et jusqu'à 0 h, pas plus loin.
    expect((await block(/^Tutorat/)).style.transform).toMatch(
      /^translate\(750px, -980(\.0+\d*)?px\)$/
    );
    expect((await block(/^Tutorat/)).textContent).toContain('0 h – 1 h');
    fireEvent.pointerUp(window);
  });

  it('l’allonge par sa poignée du bas, sans changer de jour', async () => {
    const { api } = setup();
    const tutorat = await block(/^Tutorat/);
    layoutColumns();
    fireEvent.pointerDown(tutorat.querySelector('[class*="resizeHandle"]')!, {
      button: 0,
      clientX: 320,
      clientY: 570,
    });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 605 });
    expect((await block(/^Tutorat/)).style.height).toMatch(
      /^calc\((4\.375rem \+ 35px|35px \+ 4\.375rem)\)$/
    );
    expect((await block(/^Tutorat/)).textContent).toContain('14 h – 15 h 30');
    fireEvent.pointerUp(window);
    expect((await block(/^Tutorat/)).textContent).toContain('14 h – 15 h 30, mercredi 28 octobre');
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
    fireEvent.pointerDown(tutorat, { button: 2, clientX: 320, clientY: 500 });
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 320, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 322, clientY: 502 });
    fireEvent.pointerUp(window);
    expect(api.updateTask).not.toHaveBeenCalled();

    // Ramené à son point de départ : rien à enregistrer.
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 320, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 600, clientY: 520 });
    fireEvent.pointerMove(window, { clientX: 320, clientY: 500 });
    fireEvent.pointerUp(window);
    expect(api.updateTask).not.toHaveBeenCalled();

    fireEvent.pointerDown(tutorat, { button: 0, clientX: 320, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 320, clientY: 640 });
    fireEvent.pointerUp(window);
    expect(api.updateTask).toHaveBeenCalledTimes(1);
    await waitFor(async () =>
      expect((await block(/^Tutorat/)).textContent).toContain('14 h – 15 h,')
    );
  });

  it('près du bord de la grille, la grille défile avec la tâche', async () => {
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
    fireEvent.pointerDown(tutorat, { button: 0, clientX: 320, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 320, clientY: 590 });
    frames.shift()!(0);
    expect(scrollTop).toBeGreaterThan(0);
    fireEvent.pointerUp(window);
    raf.mockRestore();
  });
});

describe('SchedulePage — liste des tâches', () => {
  it('liste les tâches de la semaine, dans l’ordre ; une tâche se coche comme terminée', async () => {
    const { api } = setup();
    const list = await screen.findByRole('region', { name: 'Mes tâches de la semaine' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['TutoratMer. 28 oct. · 14 h – 15 h', 'Lire le chapitre 4Ven. 30 oct. · 9 h – 10 h']);
    expect(
      (
        within(list).getByRole('checkbox', {
          name: 'Lire le chapitre 4 : terminée',
        }) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect((await block(/^Lire le chapitre 4/)).textContent).toContain(', terminée');

    fireEvent.click(within(list).getByRole('checkbox', { name: 'Tutorat : terminée' }));
    expect(
      (within(list).getByRole('checkbox', { name: 'Tutorat : terminée' }) as HTMLInputElement)
        .checked
    ).toBe(true);
    expect((await block(/^Tutorat/)).className).toMatch(/done/);
    expect(api.updateTask).toHaveBeenCalledWith(7, expect.objectContaining({ done: true }));

    fireEvent.click(within(list).getByRole('button', { name: /^Lire le chapitre 4/ }));
    expect(screen.getByRole('dialog', { name: 'Modifier la tâche' })).toBeTruthy();
  });

  it('une semaine sans tâche le dit', async () => {
    setup({ api: makeApi({ fetchTasks: vi.fn().mockResolvedValue([]) }) });
    expect(await screen.findByText('Aucune tâche cette semaine.')).toBeTruthy();
  });
});

describe('SchedulePage — description, corbeille, couleur des cours, défilement', () => {
  it('le bloc montre la description quand la place le permet, pas quand il est court', async () => {
    const fetchTasks = vi.fn(async (weekStart: Date) => [
      {
        ...(await weeklyTasks(weekStart))[1],
        start: at(weekStart, 4, 9),
        end: at(weekStart, 4, 12),
        notes: 'Lire les pages 80 à 95',
      },
      {
        ...(await weeklyTasks(weekStart))[1],
        id: 9,
        title: 'Court',
        start: at(weekStart, 3, 9),
        end: at(weekStart, 3, 9, 45),
        notes: 'Caché',
      },
    ]);
    setup({ api: makeApi({ fetchTasks }) });
    const long = await block(/^Lire le chapitre 4/);
    const description = long.querySelector<HTMLElement>('[class*="blockDescription"]')!;
    expect(description.textContent).toBe('Lire les pages 80 à 95');
    expect(description.style.webkitLineClamp).toBe('10');
    expect((await block(/^Court/)).querySelector('[class*="blockDescription"]')).toBeNull();
  });

  it('la corbeille de la liste supprime la tâche ; un échec la garde', async () => {
    const deleteTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('panne'))
      .mockResolvedValue(undefined);
    setup({ api: makeApi({ deleteTask }) });
    const list = await screen.findByRole('region', { name: 'Mes tâches de la semaine' });
    fireEvent.click(within(list).getByRole('button', { name: 'Supprimer « Tutorat »' }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1));
    expect(await block(/^Tutorat/)).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Supprimer « Tutorat »' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Tutorat/ })).toBeNull());
    expect(deleteTask).toHaveBeenLastCalledWith(7);
  });

  it('l’étudiant choisit la couleur d’un cours ; un échec la remet', async () => {
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
    const dialog = screen.getByRole('dialog');
    const picker = within(dialog).getByRole('group', { name: 'Ma couleur pour ce cours' });
    expect(
      (within(picker).getByRole('radio', { name: 'Sarcelle' }) as HTMLInputElement).checked
    ).toBe(true);
    fireEvent.click(within(picker).getByRole('radio', { name: 'Violet' }));
    expect(setCourseColor).toHaveBeenCalledWith(10, 'purple');
    expect((await block(/^INF201/)).style.getPropertyValue('--hue')).toBe('258');

    fireEvent.click(within(picker).getByRole('radio', { name: 'Rose' }));
    await waitFor(async () =>
      expect((await block(/^INF201/)).style.getPropertyValue('--hue')).toBe('258')
    );
  });

  it('un échec au premier choix rend au cours sa couleur par défaut', async () => {
    setup({ api: makeApi({ setCourseColor: vi.fn().mockRejectedValue(new Error('panne')) }) });
    fireEvent.click(await block(/^INF201/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: 'Violet' }));
    await waitFor(async () =>
      expect((await block(/^INF201/)).style.getPropertyValue('--hue')).toBe('174')
    );
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

describe('SchedulePage — petits blocs et tâches sans heure', () => {
  const taskAt = (
    weekStart: Date,
    id: number,
    title: string,
    day: number,
    from: [number, number],
    to: [number, number]
  ) => ({
    id,
    title,
    start: at(weekStart, day, ...from),
    end: at(weekStart, day, ...to),
    courseId: null,
    reminder: null,
    notes: '',
    color: 'blue' as const,
    done: false,
    allDay: false,
  });

  it('un petit bloc garde son titre ; les lignes qui n’y tiennent pas sont retirées', async () => {
    const fetchTasks = vi.fn(async (weekStart: Date) => [
      taskAt(weekStart, 1, 'Appel', 1, [9, 0], [9, 15]),
      taskAt(weekStart, 2, 'Lecture', 1, [11, 0], [11, 45]),
    ]);
    setup({ api: makeApi({ fetchTasks }) });
    expect((await block(/^Appel/)).className).toMatch(/tiny/);
    expect((await block(/^Lecture/)).className).toMatch(/short/);
    expect((await block(/^INF201/)).className).not.toMatch(/tiny|short/);
  });

  it('une tâche sans heure va dans la rangée « Journée » et dans la liste, et s’ouvre', async () => {
    const fetchTasks = vi.fn(async (weekStart: Date) => [
      { ...taskAt(weekStart, 3, 'Remise du TP2', 3, [0, 0], [0, 0]), allDay: true, done: true },
    ]);
    setup({ api: makeApi({ fetchTasks }) });
    const chip = await block(/^Remise du TP2/);
    expect(chip.textContent).toContain('jeudi 29 octobre, toute la journée, terminée');
    expect(screen.getByText('Journée')).toBeTruthy();
    const list = screen.getByRole('region', { name: 'Mes tâches de la semaine' });
    expect(within(list).getByRole('listitem').textContent).toBe(
      'Remise du TP2Jeu. 29 oct. · toute la journée'
    );
    fireEvent.click(chip);
    const dialog = screen.getByRole('dialog', { name: 'Modifier la tâche' });
    expect(
      (within(dialog).getByRole('checkbox', { name: 'Toute la journée' }) as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(within(dialog).queryByRole('combobox', { name: 'Début' })).toBeNull();
  });

  it('sans tâche sans heure, pas de rangée « Journée »', async () => {
    setup();
    await block(/^INF201/);
    expect(screen.queryByText('Journée')).toBeNull();
  });

  it('« Toute la journée » cache les heures ; l’aperçu va dans la rangée ; la tâche s’ajoute sans heure', async () => {
    const { api } = setup();
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    const panel = screen.getByRole('complementary');
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Titre' }), {
      target: { value: 'Remise' },
    });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Toute la journée' }));
    expect(within(panel).queryByRole('combobox', { name: 'Début' })).toBeNull();
    expect(screen.getByText('Journée')).toBeTruthy();
    expect(screen.getByText('Remise').closest('[aria-hidden]')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Ajouter la tâche' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(api.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Remise',
        allDay: true,
        start: new Date(2026, 9, 28).toISOString(),
      })
    );
    expect(await block(/^Remise/)).toBeTruthy();
  });

  it('sur mobile, la tâche sans heure ouvre sa journée', async () => {
    const fetchTasks = vi.fn(async (weekStart: Date) => [
      { ...taskAt(weekStart, 3, 'Remise du TP2', 0, [0, 0], [0, 0]), allDay: true },
    ]);
    setup({ compact: true, api: makeApi({ fetchTasks }) });
    const monday = await screen.findByRole('region', { name: 'lundi 26 octobre' });
    const buttons = within(monday).getAllByRole('button');
    expect(buttons[0].textContent).toContain('Toute la journée');
  });
});

describe('SchedulePage — glisser l’aperçu de l’ajout', () => {
  it('déplacer l’aperçu change le jour et les heures du formulaire ; l’allonger change la fin', async () => {
    setup();
    await block(/^INF201/);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une tâche' }));
    document.querySelectorAll<HTMLElement>('[class*="dayColumn"]').forEach((column, index) => {
      column.getBoundingClientRect = () =>
        ({ left: index * 150, right: (index + 1) * 150 }) as DOMRect;
    });
    const preview = () => document.querySelector<HTMLElement>('[class*="preview"]')!;
    // Mercredi 13 h – 14 h ; vers jeudi, une heure plus tard.
    fireEvent.pointerDown(preview(), { button: 0, clientX: 320, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 470, clientY: 570 });
    expect(preview().textContent).toContain('14 h – 15 h');
    expect(preview().className).toMatch(/dragging/);
    fireEvent.pointerUp(window);
    const panel = screen.getByRole('complementary');
    expect((within(panel).getByLabelText('Date') as HTMLInputElement).value).toBe('2026-10-29');
    expect(
      (within(panel).getByRole('combobox', { name: 'Début' }) as HTMLSelectElement).value
    ).toBe('14:00');
    expect((within(panel).getByRole('combobox', { name: 'Fin' }) as HTMLSelectElement).value).toBe(
      '15:00'
    );

    fireEvent.pointerDown(preview().querySelector('[class*="resizeHandle"]')!, {
      button: 0,
      clientX: 470,
      clientY: 570,
    });
    fireEvent.pointerMove(window, { clientX: 470, clientY: 605 });
    fireEvent.pointerUp(window);
    expect((within(panel).getByRole('combobox', { name: 'Fin' }) as HTMLSelectElement).value).toBe(
      '15:30'
    );
  });
});
