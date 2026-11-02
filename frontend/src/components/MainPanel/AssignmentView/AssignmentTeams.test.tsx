import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AssignmentView, { type AssignmentHandlers } from './AssignmentView';
import { ManageTeamsPopup, StudentTeamCard } from './AssignmentTeams';
import type { Assignment, AssignmentTeam } from '../../../types/domain';

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

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 9,
    courseId: 10,
    title: 'Laboratoire',
    instructions: 'Lire.',
    expectedFormats: [],
    files: [],
    isPublished: true,
    submittedCount: 0,
    gradedCount: 0,
    studentCount: 3,
    teamSize: 3,
    teamFormation: 'students',
    ...overrides,
  };
}

const FULL: AssignmentTeam = { id: 1, name: 'Équipe 1', members: ['A', 'B', 'C'] };
const OPEN: AssignmentTeam = { id: 2, name: 'Équipe 2', members: ['D'] };
const TEAMS = { teams: [FULL, OPEN], unassigned: ['E', 'F'] };

function card(a: Assignment, overrides: Partial<React.ComponentProps<typeof StudentTeamCard>> = {}) {
  const props = {
    onFetchTeams: vi.fn().mockResolvedValue(TEAMS),
    onJoin: vi.fn().mockResolvedValue(undefined),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onLeave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<StudentTeamCard assignment={a} {...props} />);
  return props;
}

describe('StudentTeamCard', () => {
  it('liste les équipes : une pastille verte si complète, jaune sinon, et aucun bouton si complète', async () => {
    card(assignment());
    const list = await screen.findByRole('list');
    const [full, open] = within(list).getAllByRole('listitem');

    expect(within(full).getByText('3/3').className).toContain('success');
    expect(within(full).queryByRole('button')).toBeNull();
    expect(within(open).getByText('1/3').className).toContain('warn');
    expect(within(open).getByRole('button', { name: 'Rejoindre Équipe 2' })).toBeTruthy();
  });

  it('rejoint et crée une équipe', async () => {
    const { onJoin, onCreate } = card(assignment());
    fireEvent.click(await screen.findByRole('button', { name: 'Rejoindre Équipe 2' }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(2));

    fireEvent.click(screen.getByRole('button', { name: 'Créer une équipe' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
  });

  it('un échec d’action le dit et laisse réessayer', async () => {
    card(assignment(), { onJoin: vi.fn().mockRejectedValue(new Error('complète')) });
    fireEvent.click(await screen.findByRole('button', { name: 'Rejoindre Équipe 2' }));
    expect((await screen.findByRole('alert')).textContent).toContain("n'a pas pu être effectuée");
    expect(
      (screen.getByRole('button', { name: 'Créer une équipe' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('un échec de chargement le dit', async () => {
    card(assignment(), { onFetchTeams: vi.fn().mockRejectedValue(new Error('panne')) });
    expect((await screen.findByRole('alert')).textContent).toContain('Impossible de charger');
  });

  it('avec une équipe : ses membres, le compte dans le coin, et « Quitter l’équipe »', async () => {
    const { onLeave, onFetchTeams } = card(assignment({ team: OPEN }));
    expect(screen.getByRole('heading', { name: 'Équipe 2' })).toBeTruthy();
    expect(screen.getByText('D')).toBeTruthy();
    expect(screen.getByText('1/3').className).toContain('warn');
    expect(onFetchTeams).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: "Quitter l'équipe" }));
    await waitFor(() => expect(onLeave).toHaveBeenCalled());
  });

  it('une équipe qui a remis, ou formée par le prof, ne se quitte pas', () => {
    const submission = { fileNames: ['a.zip'], submittedAt: new Date().toISOString(), late: false };
    card(assignment({ team: OPEN, submission }));
    expect(screen.queryByRole('button', { name: "Quitter l'équipe" })).toBeNull();
    cleanup();

    card(assignment({ team: FULL, teamFormation: 'teacher' }));
    expect(screen.queryByRole('button', { name: "Quitter l'équipe" })).toBeNull();
    expect(screen.getByText('3/3').className).toContain('success');
  });

  it('équipes du prof pas encore formées : le dit, sans rien proposer', () => {
    const { onFetchTeams } = card(assignment({ teamFormation: 'teacher' }));
    expect(screen.getByText(/n'a pas encore formé les équipes/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(onFetchTeams).not.toHaveBeenCalled();
  });
});

describe('ManageTeamsPopup', () => {
  function popup(
    overrides: {
      assignment?: Assignment;
      onFetch?: () => Promise<unknown>;
      onSave?: () => Promise<unknown>;
    } = {}
  ) {
    const onSave = vi.fn(overrides.onSave ?? (async () => undefined));
    const onClose = vi.fn();
    const props = {
      assignment: overrides.assignment ?? assignment(),
      onFetch: overrides.onFetch ?? vi.fn().mockResolvedValue(TEAMS),
      onSave,
      onClose,
    } as unknown as React.ComponentProps<typeof ManageTeamsPopup>;
    render(<ManageTeamsPopup {...props} />);
    return { onSave, onClose };
  }
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Enregistrer les équipes' }));

  it('montre les équipes et les étudiants sans équipe', async () => {
    popup();
    expect(await screen.findByText('Sans équipe (2)')).toBeTruthy();
    expect(screen.getByText('Équipe 1')).toBeTruthy();
    expect(screen.getByText(/Vous pouvez quand même les ajuster/)).toBeTruthy();
  });

  it('équipes du prof : le message le dit', async () => {
    popup({ assignment: assignment({ teamFormation: 'teacher' }) });
    expect(await screen.findByText(/dès que vous aurez enregistré/)).toBeTruthy();
  });

  it('place un étudiant, seulement dans une équipe qui a de la place, puis enregistre', async () => {
    const { onSave, onClose } = popup();
    const select = (await screen.findByLabelText('Équipe de E')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Ajouter à…', 'Équipe 2']);

    fireEvent.change(select, { target: { value: '2' } });
    expect(screen.getByText('Sans équipe (1)')).toBeTruthy();
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[0]).toEqual([FULL, { ...OPEN, members: ['D', 'E'] }]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('retire un membre, puis une équipe : leurs membres reviennent sans équipe', async () => {
    popup();
    fireEvent.click(await screen.findByRole('button', { name: 'Retirer A de Équipe 1' }));
    expect(screen.getByText('Sans équipe (3)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retirer Équipe 1' }));
    expect(screen.getByText('Sans équipe (5)')).toBeTruthy();
    expect(screen.queryByText('Équipe 1')).toBeNull();
  });

  it('ajoute une équipe vide, au premier numéro libre', async () => {
    popup();
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une équipe' }));
    expect(screen.getByText('Équipe 3', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('Aucun membre.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retirer Équipe 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une équipe' }));
    // Deux équipes restantes (2 et 3) : le numéro 3 est pris, la nouvelle devient la 4.
    expect(screen.getByText('Équipe 4', { selector: 'strong' })).toBeTruthy();
  });

  it('répartit au hasard : remplit les équipes, puis en crée au besoin', async () => {
    const { onSave } = popup({
      onFetch: vi.fn().mockResolvedValue({
        teams: [OPEN],
        unassigned: ['E', 'F', 'G', 'H'],
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Répartir au hasard' }));
    expect(screen.getByText('Sans équipe (0)')).toBeTruthy();
    expect(screen.getByText('Tous les étudiants ont une équipe.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Répartir au hasard' }) as HTMLButtonElement).disabled
    ).toBe(true);
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = (onSave.mock.calls[0] as unknown[])[0] as AssignmentTeam[];
    expect(saved.map((team) => team.members.length)).toEqual([3, 2]);
    expect(saved[1].id).toBeLessThan(0);
    expect(saved.flatMap((team) => team.members).sort()).toEqual(['D', 'E', 'F', 'G', 'H']);
  });

  it('sans place libre, la liste le dit', async () => {
    popup({ onFetch: vi.fn().mockResolvedValue({ teams: [FULL], unassigned: ['E'] }) });
    const select = (await screen.findByLabelText('Équipe de E')) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.options[0].textContent).toBe('Aucune place');
  });

  it('un échec de chargement ou d’enregistrement le dit, et garde la fenêtre ouverte', async () => {
    popup({ onFetch: vi.fn().mockRejectedValue(new Error('panne')) });
    expect((await screen.findByRole('alert')).textContent).toContain('Impossible de charger');
    cleanup();

    const { onClose } = popup({ onSave: vi.fn().mockRejectedValue(new Error('panne')) });
    await screen.findByText('Sans équipe (2)');
    save();
    expect((await screen.findByRole('alert')).textContent).toContain("n'ont pas pu être enregistrées");
    expect(onClose).not.toHaveBeenCalled();
  });

  it('« Annuler » et le ✕ ferment sans enregistrer', async () => {
    const { onSave, onClose } = popup();
    await screen.findByText('Sans équipe (2)');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    cleanup();

    const second = popup();
    await screen.findByText('Sans équipe (2)');
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(second.onClose).toHaveBeenCalledTimes(1));
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('AssignmentView — devoirs en équipe', () => {
  function view(
    props: { assignmentId: number; canManage?: boolean; assignments: Assignment[] },
    overrides: Partial<AssignmentHandlers> = {}
  ) {
    const handlers: AssignmentHandlers = {
      onFetchAssignments: vi.fn().mockResolvedValue(props.assignments),
      onSubmitAssignment: vi.fn(),
      onCreateAssignment: vi.fn(),
      onUpdateAssignment: vi.fn(),
      onFetchSubmissions: vi.fn().mockResolvedValue([]),
      onFetchSubmission: vi.fn(),
      onGradeSubmission: vi.fn(),
      onFetchTeams: vi.fn().mockResolvedValue(TEAMS),
      onSaveTeams: vi.fn(),
      onJoinTeam: vi.fn(),
      onCreateTeam: vi.fn(),
      onLeaveTeam: vi.fn(),
      onAssignmentsChanged: vi.fn(),
      ...overrides,
    };
    render(
      <AssignmentView
        course={{ id: 10, code: 'INF201' }}
        assignmentId={props.assignmentId}
        handlers={handlers}
        canManage={props.canManage}
        onOpen={vi.fn()}
      />
    );
    return handlers;
  }

  it('sans équipe, pas de remise ; en rejoindre une ouvre la remise', async () => {
    const lab = assignment();
    const onJoinTeam = vi.fn().mockResolvedValue({ ...lab, team: OPEN });
    const handlers = view({ assignmentId: 9, assignments: [lab] }, { onJoinTeam });

    fireEvent.click(await screen.findByRole('button', { name: 'Rejoindre Équipe 2' }));
    expect(screen.queryByText('Votre remise')).toBeNull();

    expect(await screen.findByText('Votre remise')).toBeTruthy();
    expect(onJoinTeam).toHaveBeenCalledWith(10, 9, 2);
    expect(handlers.onAssignmentsChanged).toHaveBeenCalled();
  });

  it('créer une équipe et la quitter passent par les bons accès', async () => {
    const lab = assignment();
    const onCreateTeam = vi.fn().mockResolvedValue({ ...lab, team: OPEN });
    const onLeaveTeam = vi.fn().mockResolvedValue(lab);
    view({ assignmentId: 9, assignments: [lab] }, { onCreateTeam, onLeaveTeam });

    fireEvent.click(await screen.findByRole('button', { name: 'Créer une équipe' }));
    fireEvent.click(await screen.findByRole('button', { name: "Quitter l'équipe" }));

    await waitFor(() => expect(onLeaveTeam).toHaveBeenCalledWith(10, 9));
    expect(onCreateTeam).toHaveBeenCalledWith(10, 9);
    expect(await screen.findByRole('button', { name: 'Créer une équipe' })).toBeTruthy();
  });

  it('le prof gère les équipes depuis le suivi, et le suivi se relit', async () => {
    const lab = assignment();
    const onSaveTeams = vi.fn().mockResolvedValue(lab);
    const handlers = view({ assignmentId: 9, canManage: true, assignments: [lab] }, { onSaveTeams });

    expect(await screen.findByText("Aucune équipe pour l'instant.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gérer les équipes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gérer les équipes' });
    await within(dialog).findByText('Sans équipe (2)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer les équipes' }));

    await waitFor(() => expect(onSaveTeams).toHaveBeenCalledWith(10, 9, [FULL, OPEN]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(handlers.onFetchSubmissions).toHaveBeenCalledTimes(2));
  });

  it('une note enregistrée passe par la vue, qui relit les devoirs', async () => {
    const lab = assignment({ teamSize: undefined, teamFormation: undefined });
    const row = {
      id: 900,
      studentName: 'Camille Lavoie',
      status: 'submitted' as const,
      files: [{ name: 'a.zip', size: '1 Ko' }],
    };
    const onFetchAssignments = vi.fn().mockResolvedValue([lab]);
    const onGradeSubmission = vi.fn().mockResolvedValue({ ...row, status: 'graded', grade: '15 / 20' });
    const onFetchSubmission = vi.fn().mockResolvedValue({ assignment: lab, rows: [row] });
    const onOpen = vi.fn();
    const handlers = {
      onFetchAssignments,
      onSubmitAssignment: vi.fn(),
      onCreateAssignment: vi.fn(),
      onUpdateAssignment: vi.fn(),
      onFetchSubmissions: vi.fn().mockResolvedValue([]),
      onFetchSubmission,
      onGradeSubmission,
      onFetchTeams: vi.fn(),
      onSaveTeams: vi.fn(),
      onJoinTeam: vi.fn(),
      onCreateTeam: vi.fn(),
      onLeaveTeam: vi.fn(),
    };
    render(
      <AssignmentView
        course={{ id: 10, code: 'INF201' }}
        assignmentId={0}
        submissionId={900}
        handlers={handlers}
        canManage
        onOpen={onOpen}
      />
    );

    await screen.findByRole('heading', { name: 'Camille Lavoie' });
    expect(onFetchSubmission).toHaveBeenCalledWith(10, 900);
    fireEvent.change(screen.getByLabelText(/^Note sur 20/), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la note' }));

    await waitFor(() =>
      expect(onGradeSubmission).toHaveBeenCalledWith(10, 900, { score: 15, comment: '' })
    );
    await waitFor(() => expect(onFetchAssignments).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Toutes les remises' }));
    expect(onOpen).toHaveBeenCalledWith(lab.id);
  });

  it('un devoir individuel n’offre pas de gestion d’équipes', async () => {
    view({
      assignmentId: 9,
      canManage: true,
      assignments: [assignment({ teamSize: undefined, teamFormation: undefined })],
    });
    await screen.findByRole('heading', { name: 'Laboratoire' });
    expect(screen.queryByRole('button', { name: 'Gérer les équipes' })).toBeNull();
  });
});
