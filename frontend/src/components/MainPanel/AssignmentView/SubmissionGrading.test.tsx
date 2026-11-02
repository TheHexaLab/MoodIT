import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SubmissionGrading } from './SubmissionGrading';
import type { Assignment, AssignmentStudentRow } from '../../../types/domain';

afterEach(cleanup);

const ASSIGNMENT: Assignment = {
  id: 5,
  courseId: 10,
  title: 'Devoir 5',
  instructions: 'Première consigne.\n\nDeuxième consigne.',
  expectedFormats: [],
  files: [],
  isPublished: true,
  submittedCount: 3,
  gradedCount: 1,
  studentCount: 4,
};

const ROWS: AssignmentStudentRow[] = [
  {
    id: 500,
    studentName: 'Camille Lavoie',
    status: 'graded',
    submittedAt: new Date(2026, 10, 1, 19, 4).toISOString(),
    files: [{ name: 'a.zip', size: '1 Ko' }],
    grade: '18 / 20',
    comment: 'Bien',
  },
  {
    id: 501,
    studentName: 'Thomas Bélanger',
    status: 'submitted',
    files: [
      { name: 'b.zip', size: '1 Ko' },
      { name: 'rapport.pdf', size: '2 Ko' },
    ],
  },
  { id: 502, studentName: 'Équipe 3', members: ['Léa', 'Samuel'], status: 'late', files: [] },
  { id: 503, studentName: 'Maya Tran', status: 'missing', files: [] },
];

function setup(submissionId: number, overrides: { onGrade?: ReturnType<typeof vi.fn> } = {}) {
  const props = {
    onFetch: vi.fn().mockResolvedValue({ assignment: ASSIGNMENT, rows: ROWS }),
    onGrade:
      overrides.onGrade ??
      vi.fn(async (id: number, grade: { score: number; comment: string }) => ({
        ...ROWS.find((row) => row.id === id)!,
        status: 'graded' as const,
        grade: `${grade.score} / 20`,
        comment: grade.comment,
      })),
    onBack: vi.fn(),
    onOpenSubmission: vi.fn(),
  };
  const typed = props as unknown as Omit<
    React.ComponentProps<typeof SubmissionGrading>,
    'submissionId'
  >;
  render(<SubmissionGrading submissionId={submissionId} {...typed} />);
  return props;
}

const score = () => screen.getByLabelText(/^Note sur 20/) as HTMLInputElement;
const comment = () => screen.getByLabelText('Commentaire') as HTMLTextAreaElement;

describe('SubmissionGrading', () => {
  it('annonce le chargement, puis montre la remise et ses fichiers', async () => {
    setup(501);
    expect(screen.getByRole('status').textContent).toContain('Chargement de la remise');

    expect(await screen.findByRole('heading', { name: 'Thomas Bélanger' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Fichiers remis (2)' })).toBeTruthy();
    expect(screen.getByText('rapport.pdf')).toBeTruthy();
    expect(screen.getByText('Deuxième consigne.')).toBeTruthy();
    expect(screen.getByText('2 sur 3')).toBeTruthy();
  });

  it('une remise déjà notée repart de sa note et de son commentaire', async () => {
    setup(500);
    await screen.findByRole('heading', { name: 'Camille Lavoie' });
    expect(score().value).toBe('18');
    expect(comment().value).toBe('Bien');
    expect(screen.getByRole('heading', { name: 'Fichier remis' })).toBeTruthy();
    expect(screen.getByText(/Remis le 1 novembre/)).toBeTruthy();
  });

  it('exige une note, et garde la note dans le barème', async () => {
    const { onGrade } = setup(501);
    await screen.findByRole('heading', { name: 'Thomas Bélanger' });

    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer seulement' }));
    expect(screen.getByRole('alert').textContent).toContain('Entrez une note');
    expect(onGrade).not.toHaveBeenCalled();

    fireEvent.change(score(), { target: { value: '25' } });
    expect(score().value).toBe('20');
  });

  it('« Enregistrer seulement » reste sur la remise et confirme', async () => {
    const { onGrade, onOpenSubmission } = setup(501);
    await screen.findByRole('heading', { name: 'Thomas Bélanger' });

    fireEvent.change(score(), { target: { value: '16.5' } });
    fireEvent.change(comment(), { target: { value: ' Très bien ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer seulement' }));

    expect((await screen.findByRole('status')).textContent).toContain('Note enregistrée');
    expect(onGrade).toHaveBeenCalledWith(501, { score: 16.5, comment: 'Très bien' });
    expect(onOpenSubmission).not.toHaveBeenCalled();

    fireEvent.change(comment(), { target: { value: 'Modifié' } });
    expect(screen.queryByText('Note enregistrée.')).toBeNull();
  });

  it('« Enregistrer et passer au suivant » ouvre la remise suivante, sans les manquants', async () => {
    const { onOpenSubmission } = setup(501);
    await screen.findByRole('heading', { name: 'Thomas Bélanger' });

    fireEvent.change(score(), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer et passer au suivant' }));

    await waitFor(() => expect(onOpenSubmission).toHaveBeenCalledWith(502));
  });

  it('la dernière remise n’offre qu’un seul enregistrement', async () => {
    const { onGrade, onOpenSubmission } = setup(502);
    await screen.findByRole('heading', { name: 'Équipe 3' });
    expect(screen.queryByRole('button', { name: 'Enregistrer seulement' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Suivant' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(score(), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la note' }));

    await waitFor(() => expect(onGrade).toHaveBeenCalled());
    expect(onOpenSubmission).not.toHaveBeenCalled();
  });

  it('Précédent et Suivant changent de remise ; la première n’a pas de précédente', async () => {
    const { onOpenSubmission } = setup(501);
    await screen.findByRole('heading', { name: 'Thomas Bélanger' });
    fireEvent.click(screen.getByRole('button', { name: 'Précédent' }));
    expect(onOpenSubmission).toHaveBeenLastCalledWith(500);
    fireEvent.click(screen.getByRole('button', { name: 'Suivant' }));
    expect(onOpenSubmission).toHaveBeenLastCalledWith(502);
    cleanup();

    setup(500);
    await screen.findByRole('heading', { name: 'Camille Lavoie' });
    expect((screen.getByRole('button', { name: 'Précédent' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('une remise d’équipe montre ses membres, et la note vaut pour toute l’équipe', async () => {
    setup(502);
    await screen.findByRole('heading', { name: 'Équipe 3' });
    expect(screen.getByRole('region', { name: "Membres de l'équipe" }).textContent).toContain('Léa');
    expect(screen.getByText(/s'appliquent à toute l'équipe/)).toBeTruthy();
  });

  it('les remarques fréquentes s’ajoutent au commentaire', async () => {
    setup(501);
    await screen.findByRole('heading', { name: 'Thomas Bélanger' });

    fireEvent.click(screen.getByRole('button', { name: 'Très bon travail.' }));
    expect(comment().value).toBe('Très bon travail.');
    fireEvent.click(screen.getByRole('button', { name: 'Rapport à étoffer.' }));
    expect(comment().value).toBe('Très bon travail. Rapport à étoffer.');
  });

  it('un échec d’enregistrement le dit et laisse réessayer', async () => {
    setup(501, { onGrade: vi.fn().mockRejectedValue(new Error('panne')) });
    await screen.findByRole('heading', { name: 'Thomas Bélanger' });

    fireEvent.change(score(), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer seulement' }));

    expect((await screen.findByRole('alert')).textContent).toContain("n'a pas pu être enregistrée");
    expect(
      (screen.getByRole('button', { name: 'Enregistrer seulement' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('un étudiant sans remise n’a rien à noter, et on revient au suivi du devoir', async () => {
    const { onBack } = setup(503);
    expect(await screen.findByText("Cet étudiant n'a rien remis.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Note sur 20/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toutes les remises' }));
    expect(onBack).toHaveBeenCalledWith(5);
  });

  it('« Toutes les remises » revient au suivi du devoir', async () => {
    const { onBack } = setup(501);
    await screen.findByRole('heading', { name: 'Thomas Bélanger' });
    fireEvent.click(screen.getByRole('button', { name: 'Toutes les remises' }));
    expect(onBack).toHaveBeenCalledWith(5);
  });

  it('une remise introuvable le dit, et on revient à la liste', async () => {
    const onBack = vi.fn();
    render(
      <SubmissionGrading
        submissionId={1}
        onFetch={vi.fn().mockRejectedValue(new Error('introuvable'))}
        onGrade={vi.fn()}
        onBack={onBack}
        onOpenSubmission={vi.fn()}
      />
    );
    expect((await screen.findByRole('alert')).textContent).toContain("n'existe plus");
    fireEvent.click(screen.getByRole('button', { name: 'Tous les devoirs' }));
    expect(onBack).toHaveBeenCalledWith();
  });
});
