import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AssignmentView, { type AssignmentHandlers } from './AssignmentView';
import type { Assignment, AssignmentStudentRow } from '../../../types/domain';

afterEach(cleanup);

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
});

const NOW = new Date(2026, 9, 30, 12, 0);
const course = { id: 10, code: 'INF201', title: 'Structures de données' };

function assignment(overrides: Partial<Assignment>): Assignment {
  return {
    id: 1,
    courseId: 10,
    title: 'Devoir',
    instructions: '',
    expectedFormats: [],
    files: [],
    isPublished: true,
    submittedCount: 24,
    gradedCount: 10,
    studentCount: 32,
    ...overrides,
  };
}

const DRAFT = assignment({ id: 7, title: 'Brouillon A', isPublished: false, submittedCount: 0 });
const DATED_DRAFT = assignment({
  id: 8,
  title: 'Brouillon B',
  isPublished: false,
  dueAt: new Date(2026, 10, 9, 23, 59).toISOString(),
});
const OPEN = assignment({
  id: 5,
  title: 'En cours',
  dueAt: new Date(2026, 10, 3, 23, 59).toISOString(),
  weight: 20,
});
const GRADED = assignment({
  id: 4,
  title: 'Fini',
  dueAt: new Date(2026, 9, 16, 23, 59).toISOString(),
  submittedCount: 32,
  gradedCount: 32,
});
const GRADING = assignment({
  id: 3,
  title: 'À corriger',
  dueAt: new Date(2026, 9, 2, 23, 59).toISOString(),
  submittedCount: 30,
  gradedCount: 12,
});

const ROWS: AssignmentStudentRow[] = [
  {
    studentName: 'Camille Lavoie',
    status: 'graded',
    submittedAt: new Date(2026, 10, 1, 19, 4).toISOString(),
    fileName: 'a.zip',
    grade: '18 / 20',
  },
  { studentName: 'Thomas Bélanger', status: 'submitted', fileName: 'b.zip' },
  { studentName: 'Samuel Roy', status: 'late', fileName: 'c.zip' },
  { studentName: 'Maya Tran', status: 'missing' },
];

function setup(
  assignmentId: number,
  overrides: Partial<AssignmentHandlers> = {},
  assignments: Assignment[] = [GRADING, GRADED, OPEN, DRAFT, DATED_DRAFT]
) {
  const handlers: AssignmentHandlers = {
    onFetchAssignments: vi.fn().mockResolvedValue(assignments),
    onSubmitAssignment: vi.fn(),
    onCreateAssignment: vi.fn(),
    onUpdateAssignment: vi.fn(),
    onFetchSubmissions: vi.fn().mockResolvedValue(ROWS),
    onAssignmentsChanged: vi.fn(),
    ...overrides,
  };
  const onOpen = vi.fn();
  render(
    <AssignmentView
      course={course}
      assignmentId={assignmentId}
      handlers={handlers}
      canManage
      onOpen={onOpen}
      now={NOW}
    />
  );
  return { handlers, onOpen };
}

describe('devoirs, côté prof — liste', () => {
  it('demande aussi les brouillons, et donne le statut de chaque devoir', async () => {
    const { handlers } = setup(0);
    expect((await screen.findByRole('button', { name: /En cours/ })).textContent).toContain('Publié');
    expect(handlers.onFetchAssignments).toHaveBeenCalledWith(10, true);

    expect(screen.getByRole('button', { name: /En cours/ }).textContent).toContain('24 / 32 remis');
    expect(screen.getByRole('button', { name: /Fini/ }).textContent).toContain('Corrigé');
    expect(screen.getByRole('button', { name: /Fini/ }).textContent).toContain('Terminé le');
    expect(screen.getByRole('button', { name: /À corriger/ }).textContent).toContain('En correction');
    const draft = screen.getByRole('button', { name: /Brouillon A/ });
    expect(draft.textContent).toContain('date limite à définir');
    expect(draft.textContent).not.toContain('remis');
    expect(screen.getByRole('button', { name: /Brouillon B/ }).textContent).toContain(
      'date limite le 9 novembre'
    );
    expect(screen.getByText('3 publiés, 2 brouillons')).toBeTruthy();
  });

  it('seule la tuile d’un brouillon est grise', async () => {
    setup(0);
    const tile = async (name: RegExp) =>
      (await screen.findByRole('button', { name })).querySelector('span')!.className;
    expect(await tile(/Brouillon A/)).toContain('muted');
    expect(await tile(/En cours/)).not.toContain('muted');
  });

  it('un seul brouillon : au singulier', async () => {
    setup(0, {}, [OPEN, DRAFT]);
    expect(await screen.findByText('1 publié, 1 brouillon')).toBeTruthy();
  });

  it('sans devoir : un message, et le bouton reste offert', async () => {
    setup(0, {}, []);
    expect(await screen.findByText('Aucun devoir pour le moment.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nouveau devoir' })).toBeTruthy();
  });

  it('un devoir publié ouvre le suivi, un brouillon ouvre la fenêtre', async () => {
    const { onOpen } = setup(0);
    fireEvent.click(await screen.findByRole('button', { name: /En cours/ }));
    expect(onOpen).toHaveBeenCalledWith(5);

    fireEvent.click(screen.getByRole('button', { name: /Brouillon A/ }));
    expect(screen.getByRole('dialog', { name: 'Modifier le devoir' })).toBeTruthy();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('« Nouveau devoir » crée le devoir et l’ajoute à la liste', async () => {
    const created = assignment({ id: 9, title: 'Tout neuf', isPublished: false, submittedCount: 0 });
    const onCreateAssignment = vi.fn().mockResolvedValue(created);
    const { handlers } = setup(0, { onCreateAssignment });

    fireEvent.click(await screen.findByRole('button', { name: 'Nouveau devoir' }));
    const dialog = screen.getByRole('dialog', { name: 'Nouveau devoir' });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Tout neuf' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer le brouillon' }));

    expect(await screen.findByRole('button', { name: /Tout neuf/ })).toBeTruthy();
    expect(onCreateAssignment).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ title: 'Tout neuf', isPublished: false })
    );
    expect(handlers.onAssignmentsChanged).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('devoirs, côté prof — suivi des remises', () => {
  it('annonce le chargement, puis les chiffres et une ligne par étudiant', async () => {
    setup(5);
    expect((await screen.findByRole('status')).textContent).toContain('Chargement');

    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(ROWS.length + 1);
    const stat = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement!;
    expect(stat('Remis').textContent).toContain('3 / 4');
    expect(stat('En retard').textContent).toContain('1');
    expect(stat('Manquants').textContent).toContain('1');
    expect(stat('Corrigés').textContent).toContain('1 / 3');

    const camille = within(table).getByRole('row', { name: /Camille Lavoie/ });
    expect(camille.textContent).toContain('18 / 20');
    expect(camille.textContent).toContain('1 novembre, 19 h 04');
    expect(within(table).getByRole('row', { name: /Thomas Bélanger/ }).textContent).toContain('À noter');
    expect(within(table).getByRole('row', { name: /Maya Tran/ }).textContent).toContain('Manquant');
    expect(screen.getByText(/Date limite : 3 novembre, 23 h 59 · 20 % de la note/)).toBeTruthy();
  });

  it('sans date limite ni pondération : le sous-titre le dit', async () => {
    setup(5, {}, [assignment({ id: 5, title: 'Libre' })]);
    expect(await screen.findByText('Sans date limite')).toBeTruthy();
    await screen.findByRole('table');
  });

  it('« Publier les notes » n’est pas encore actif', async () => {
    setup(5);
    const button = await screen.findByRole('button', { name: 'Publier les notes' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await screen.findByRole('table');
  });

  it('un échec du suivi le dit', async () => {
    setup(5, { onFetchSubmissions: vi.fn().mockRejectedValue(new Error('panne')) });
    expect((await screen.findByRole('alert')).textContent).toContain('Impossible de charger les remises');
  });

  it('« Tous les devoirs » revient à la liste', async () => {
    const { onOpen } = setup(5);
    fireEvent.click(await screen.findByRole('button', { name: 'Tous les devoirs' }));
    expect(onOpen).toHaveBeenCalledWith(0);
    await screen.findByRole('table');
  });

  it('« Modifier le devoir » enregistre et met à jour la page', async () => {
    const onUpdateAssignment = vi.fn().mockResolvedValue({ ...OPEN, title: 'Renommé' });
    const { handlers } = setup(5, { onUpdateAssignment });

    fireEvent.click(await screen.findByRole('button', { name: 'Modifier le devoir' }));
    const dialog = screen.getByRole('dialog', { name: 'Modifier le devoir' });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Renommé' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByRole('heading', { name: 'Renommé' })).toBeTruthy();
    expect(onUpdateAssignment).toHaveBeenCalledWith(
      10,
      5,
      expect.objectContaining({ title: 'Renommé' })
    );
    expect(handlers.onAssignmentsChanged).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
