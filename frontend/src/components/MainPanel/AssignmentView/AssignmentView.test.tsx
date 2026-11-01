import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AssignmentView, { type AssignmentHandlers } from './AssignmentView';
import { MAX_FILE_BYTES } from './assignmentFormat';
import type { Assignment } from '../../../types/domain';

afterEach(cleanup);

const NOW = new Date(2026, 9, 30, 12, 0);
const course = { id: 10, code: 'INF201', title: 'Structures de données' };
const iso = (day: number, hour = 23) => new Date(2026, 10, day, hour, 59).toISOString();

function assignment(overrides: Partial<Assignment>): Assignment {
  return {
    id: 1,
    courseId: 10,
    title: 'Devoir',
    instructions: 'Lire le chapitre.',
    expectedFormats: [],
    files: [],
    isPublished: true,
    submittedCount: 0,
    gradedCount: 0,
    studentCount: 32,
    ...overrides,
  };
}

const TO_DO = assignment({
  id: 5,
  title: 'Devoir 5',
  dueAt: iso(3),
  weight: 20,
  expectedFormats: ['.pdf', '.zip'],
  instructions: 'Première consigne.\n\nDeuxième consigne.',
  files: [{ name: 'enonce.pdf', size: '240 Ko' }],
  publishedBy: 'Prof. Tremblay',
});
const LATER = assignment({ id: 6, title: 'Devoir 6', dueAt: iso(20) });
const GRADED = assignment({
  id: 4,
  title: 'Devoir 4',
  dueAt: new Date(2026, 9, 16).toISOString(),
  submission: {
    fileName: 'devoir4.pdf',
    submittedAt: new Date(2026, 9, 15, 21, 12).toISOString(),
    late: false,
    grade: '17 / 20',
  },
});

function setup(
  props: { assignmentId?: number; assignments?: Assignment[] } = {},
  overrides: Partial<AssignmentHandlers> = {}
) {
  const handlers: AssignmentHandlers = {
    onFetchAssignments: vi.fn().mockResolvedValue(props.assignments ?? [LATER, TO_DO, GRADED]),
    onSubmitAssignment: vi.fn(),
    onCreateAssignment: vi.fn(),
    onUpdateAssignment: vi.fn(),
    onFetchSubmissions: vi.fn(),
    onAssignmentsChanged: vi.fn(),
    ...overrides,
  };
  const onOpen = vi.fn();
  render(
    <AssignmentView
      course={course}
      assignmentId={props.assignmentId ?? 0}
      handlers={handlers}
      onOpen={onOpen}
      now={NOW}
    />
  );
  return { handlers, onOpen };
}

const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const pickFile = (name: string, size = 10) => {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  fireEvent.change(fileInput(), { target: { files: [file] } });
};

describe('AssignmentView — liste, côté étudiant', () => {
  it('annonce le chargement, puis sépare ce qui reste à remettre de ce qui est remis', async () => {
    setup();
    expect(screen.getByRole('status').textContent).toContain('Chargement des devoirs');

    const toSubmit = await screen.findByRole('region', { name: 'À remettre' });
    const rows = within(toSubmit).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Devoir 5'),
      expect.stringContaining('Devoir 6'),
    ]);
    expect(rows[0].textContent).toContain('Dans 4 jours');
    expect(rows[0].textContent).toContain('20 %');

    const submitted = screen.getByRole('region', { name: 'Remis' });
    expect(submitted.textContent).toContain('17 / 20');
    expect(submitted.textContent).toContain('Corrigé');
    expect(screen.getByText('2 à remettre, 1 remis')).toBeTruthy();
  });

  it('une ligne et la carte « Prochaine échéance » ouvrent le devoir', async () => {
    const { onOpen } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /Devoir 6/ }));
    expect(onOpen).toHaveBeenLastCalledWith(6);

    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le devoir' }));
    expect(onOpen).toHaveBeenLastCalledWith(5);
  });

  it('sans devoir : un message, sans carte d’échéance', async () => {
    setup({ assignments: [] });
    expect(await screen.findByText('Aucun devoir pour le moment.')).toBeTruthy();
    expect(screen.queryByText('Prochaine échéance')).toBeNull();
  });

  it('une remise en retard le dit, et un devoir sans note reste « En correction »', async () => {
    setup({
      assignments: [
        assignment({
          id: 3,
          title: 'Devoir 3',
          submission: { fileName: 'a.zip', submittedAt: iso(1), late: true },
        }),
      ],
    });
    const row = await screen.findByRole('button', { name: /Devoir 3/ });
    expect(row.textContent).toContain('en retard');
    expect(row.textContent).toContain('En correction');
  });

  it('un échec de chargement propose de réessayer', async () => {
    const onFetchAssignments = vi
      .fn()
      .mockRejectedValueOnce(new Error('panne'))
      .mockResolvedValue([TO_DO]);
    setup({}, { onFetchAssignments });

    fireEvent.click(await screen.findByRole('button', { name: 'Réessayer' }));
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'À remettre' })).toBeTruthy();
    expect(onFetchAssignments).toHaveBeenCalledTimes(2);
  });
});

describe('AssignmentView — devoir ouvert, côté étudiant', () => {
  it('montre les consignes, les fichiers et les repères du devoir', async () => {
    setup({ assignmentId: 5 });

    expect(await screen.findByRole('heading', { name: 'Devoir 5' })).toBeTruthy();
    expect(screen.getByText('Première consigne.')).toBeTruthy();
    expect(screen.getByText('Deuxième consigne.')).toBeTruthy();
    expect(screen.getByText('enonce.pdf')).toBeTruthy();
    expect(screen.getByText('20 % de la note')).toBeTruthy();
    expect(screen.getByText('Publié par Prof. Tremblay')).toBeTruthy();
    expect(screen.getByText('.pdf ou .zip, 25 Mo au maximum')).toBeTruthy();
    expect(fileInput().accept).toBe('.pdf,.zip');
  });

  it('« Tous les devoirs » revient à la liste', async () => {
    const { onOpen } = setup({ assignmentId: 5 });
    fireEvent.click(await screen.findByRole('button', { name: 'Tous les devoirs' }));
    expect(onOpen).toHaveBeenCalledWith(0);
  });

  it('un devoir introuvable le dit et permet de revenir', async () => {
    const { onOpen } = setup({ assignmentId: 999 });
    expect(await screen.findByText("Ce devoir n'existe plus.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tous les devoirs' }));
    expect(onOpen).toHaveBeenCalledWith(0);
  });

  it('remet un fichier accepté et prévient le parent', async () => {
    const updated = {
      ...TO_DO,
      submission: { fileName: 'mon.zip', submittedAt: iso(1), late: false },
    };
    const onSubmitAssignment = vi.fn().mockResolvedValue(updated);
    const { handlers } = setup({ assignmentId: 5 }, { onSubmitAssignment });

    const send = await screen.findByRole('button', { name: 'Remettre le devoir' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    pickFile('mon.zip');
    expect(screen.getByText('Prêt à remettre')).toBeTruthy();
    fireEvent.click(send);

    await waitFor(() => expect(screen.getByText('mon.zip')).toBeTruthy());
    expect(onSubmitAssignment).toHaveBeenCalledWith(10, 5, 'mon.zip');
    expect(handlers.onAssignmentsChanged).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remplacer ma remise' })).toBeTruthy();
    expect(screen.getByText('Remis')).toBeTruthy();
  });

  it('refuse un mauvais format et un fichier trop gros', async () => {
    setup({ assignmentId: 5 });
    await screen.findByRole('heading', { name: 'Devoir 5' });

    pickFile('photo.png');
    expect(screen.getByRole('alert').textContent).toContain('Format non accepté');
    expect(
      (screen.getByRole('button', { name: 'Remettre le devoir' }) as HTMLButtonElement).disabled
    ).toBe(true);

    pickFile('gros.zip', MAX_FILE_BYTES + 1);
    expect(screen.getByRole('alert').textContent).toContain('dépasse 25 Mo');
  });

  it('un choix de fichier annulé ne change rien', async () => {
    setup({ assignmentId: 5 });
    await screen.findByRole('heading', { name: 'Devoir 5' });
    fireEvent.change(fileInput(), { target: { files: [] } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('dépose un fichier par glisser-déposer', async () => {
    setup({ assignmentId: 5 });
    await screen.findByRole('heading', { name: 'Devoir 5' });
    const zone = fileInput().closest('label')!;

    fireEvent.dragOver(zone);
    expect(zone.className).toContain('dropActive');
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toContain('dropActive');
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'rapport.pdf')] } });

    expect(screen.getByText('rapport.pdf')).toBeTruthy();
  });

  it('garde le fichier et avertit si l’envoi échoue', async () => {
    const onSubmitAssignment = vi.fn().mockRejectedValue(new Error('panne'));
    setup({ assignmentId: 5 }, { onSubmitAssignment });
    await screen.findByRole('heading', { name: 'Devoir 5' });

    pickFile('mon.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Remettre le devoir' }));

    expect((await screen.findByRole('alert')).textContent).toContain("n'a pas pu être envoyée");
    expect(screen.getByText('mon.pdf')).toBeTruthy();
  });

  it('un devoir corrigé ne se remplace plus et montre la note', async () => {
    setup({ assignmentId: 4 });
    expect(await screen.findByText('devoir4.pdf')).toBeTruthy();
    expect(screen.getByText(/Note : 17 \/ 20/)).toBeTruthy();
    expect(fileInput()).toBeNull();
  });

  it('après la date limite, une remise ne se remplace plus', async () => {
    const late = assignment({
      id: 7,
      title: 'Passé',
      dueAt: new Date(2026, 9, 20).toISOString(),
      submission: { fileName: 'a.pdf', submittedAt: new Date(2026, 9, 19).toISOString(), late: false },
    });
    setup({ assignmentId: 7, assignments: [late] });
    await screen.findByRole('heading', { name: 'Passé' });
    expect(fileInput()).toBeNull();
  });

  it('un devoir pas encore remis se remet même en retard, sans promesse de remplacement', async () => {
    const overdue = assignment({ id: 8, title: 'Oublié' });
    setup({ assignmentId: 8, assignments: [overdue] });
    await screen.findByRole('heading', { name: 'Oublié' });
    expect(fileInput()).not.toBeNull();
    expect(screen.getByText('Sans date limite')).toBeTruthy();
    expect(screen.queryByText(/jusqu'à la date limite/)).toBeNull();
    expect(fileInput().accept).toBe('');
  });
});
