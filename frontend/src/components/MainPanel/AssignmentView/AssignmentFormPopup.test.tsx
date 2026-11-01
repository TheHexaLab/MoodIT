import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssignmentFormPopup } from './AssignmentFormPopup';
import type { Assignment } from '../../../types/domain';

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

const EXISTING: Assignment = {
  id: 5,
  courseId: 10,
  title: 'Devoir 5',
  instructions: 'Lire.',
  dueAt: new Date(2026, 10, 3, 18, 30).toISOString(),
  weight: 20,
  expectedFormats: ['.pdf', '.py'],
  files: [{ name: 'enonce.pdf', size: '240 Ko' }],
  isPublished: true,
  submittedCount: 0,
  gradedCount: 0,
  studentCount: 32,
};

function setup(assignment?: Assignment, onSave = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  render(
    <AssignmentFormPopup
      courseLabel="INF201 · Structures de données"
      assignment={assignment}
      onClose={onClose}
      onSave={onSave}
    />
  );
  return { onClose, onSave };
}

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const publish = () => fireEvent.click(screen.getByRole('button', { name: 'Publier le devoir' }));
const saveDraft = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));

describe('AssignmentFormPopup', () => {
  it('passe par le composant Popup, avec le cours en sous-titre', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Nouveau devoir' })).toBeTruthy();
    expect(screen.getByText('INF201 · Structures de données')).toBeTruthy();
  });

  it('ne propose pas de quiz comme moyen de remise, et le format reste facultatif', () => {
    setup();
    expect(screen.queryByText(/quiz/i)).toBeNull();
    expect(screen.getByText('Format de fichier attendu (facultatif)')).toBeTruthy();
    expect(screen.getByText('Sans choix, tous les formats sont acceptés.')).toBeTruthy();
  });

  it('publie un devoir complet, puis se ferme', async () => {
    const { onSave, onClose } = setup();
    fill('Titre', '  Devoir 6  ');
    fill('Consignes', 'Coder un arbre.');
    fill('Date limite', '2026-11-20');
    fill('Pondération (%)', '20');
    fireEvent.click(screen.getByRole('button', { name: '.zip' }));
    publish();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      title: 'Devoir 6',
      instructions: 'Coder un arbre.',
      dueAt: new Date('2026-11-20T23:59').toISOString(),
      weight: 20,
      expectedFormats: ['.zip'],
      files: [],
      isPublished: true,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('un brouillon n’a besoin que d’un titre', async () => {
    const { onSave } = setup();
    fill('Titre', 'Plus tard');
    saveDraft();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      title: 'Plus tard',
      dueAt: undefined,
      weight: undefined,
      isPublished: false,
    });
  });

  it('garde la pondération entre 0 et 100 pendant la saisie', () => {
    setup();
    const weight = () => (screen.getByLabelText('Pondération (%)') as HTMLInputElement).value;
    fill('Pondération (%)', '140');
    expect(weight()).toBe('100');
    fill('Pondération (%)', '-5');
    expect(weight()).toBe('0');
    fill('Pondération (%)', '12.5');
    expect(weight()).toBe('12.5');
  });

  it('exige un titre, et une date pour publier', () => {
    const { onSave } = setup();
    saveDraft();
    expect(screen.getByRole('alert').textContent).toContain('Donnez un titre');

    fill('Titre', 'Devoir');
    publish();
    expect(screen.getByRole('alert').textContent).toContain('date limite');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('une heure vidée retombe sur 23 h 59', async () => {
    const { onSave } = setup();
    fill('Titre', 'Devoir');
    fill('Date limite', '2026-11-20');
    fill('Heure', '');
    publish();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].dueAt).toBe(new Date('2026-11-20T23:59').toISOString());
  });

  it('propose des extensions, dont .zip et .xlsx', () => {
    setup();
    expect(screen.getByRole('button', { name: '.zip' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '.xlsx' })).toBeTruthy();
  });

  it('un format se sélectionne et se désélectionne', () => {
    setup();
    const pdf = screen.getByRole('button', { name: '.pdf' });
    fireEvent.click(pdf);
    expect(pdf.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(pdf);
    expect(pdf.getAttribute('aria-pressed')).toBe('false');
  });

  it('« Autre » ajoute une extension, avec ou sans point, une seule fois', () => {
    setup();
    const add = (value: string, key = 'Enter') => {
      fireEvent.click(screen.getByRole('button', { name: /Autre/ }));
      const input = screen.getByLabelText('Autre format');
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key });
    };

    add('PY');
    expect(screen.getByRole('button', { name: /\.py/ }).getAttribute('aria-pressed')).toBe('true');
    add('.py');
    expect(screen.getAllByRole('button', { name: /\.py/ })).toHaveLength(1);
  });

  it('dans « Autre », Échap annule sans fermer la fenêtre, et un champ vide n’ajoute rien', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Autre/ }));
    const input = screen.getByLabelText('Autre format');
    fireEvent.change(input, { target: { value: 'py' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Autre format')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /\.py/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Autre/ }));
    fireEvent.blur(screen.getByLabelText('Autre format'));
    expect(screen.queryByLabelText('Autre format')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Autre/ }));
    fireEvent.keyDown(screen.getByLabelText('Autre format'), { key: 'a' });
    expect(screen.getByLabelText('Autre format')).toBeTruthy();
  });

  it('joint et retire des fichiers, avec leur taille', () => {
    setup();
    const big = new File(['x'], 'gros.zip');
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('Ajouter des fichiers au devoir'), {
      target: { files: [new File(['x'], 'enonce.pdf'), big] },
    });
    expect(screen.getByText('enonce.pdf (1 Ko)')).toBeTruthy();
    expect(screen.getByText('gros.zip (3 Mo)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retirer enonce.pdf' }));
    expect(screen.queryByText('enonce.pdf (1 Ko)')).toBeNull();
  });

  it('un choix de fichiers annulé ne change rien', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Ajouter des fichiers au devoir'), {
      target: { files: null },
    });
    expect(screen.queryByRole('button', { name: /^Retirer/ })).toBeNull();
  });

  it('pré-remplit un devoir publié : un seul bouton pour enregistrer, sans brouillon', async () => {
    const { onSave } = setup(EXISTING);
    expect(screen.getByRole('dialog', { name: 'Modifier le devoir' })).toBeTruthy();
    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('Devoir 5');
    expect((screen.getByLabelText('Date limite') as HTMLInputElement).value).toBe('2026-11-03');
    expect((screen.getByLabelText('Heure') as HTMLInputElement).value).toBe('18:30');
    expect(screen.getByRole('button', { name: /\.py/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Enregistrer le brouillon' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ isPublished: true, weight: 20 });
  });

  it('un brouillon sans date ni pondération s’ouvre avec des champs vides', () => {
    setup({ ...EXISTING, isPublished: false, dueAt: undefined, weight: undefined });
    expect((screen.getByLabelText('Date limite') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Heure') as HTMLInputElement).value).toBe('23:59');
    expect(screen.getByRole('button', { name: 'Enregistrer le brouillon' })).toBeTruthy();
  });

  it('un échec garde la fenêtre ouverte et permet de réessayer', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('panne'));
    const { onClose } = setup(undefined, onSave);
    fill('Titre', 'Devoir');
    saveDraft();

    expect((await screen.findByRole('alert')).textContent).toContain("n'a pas pu être enregistré");
    expect(onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Enregistrer le brouillon' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('« Annuler » et le ✕ ferment sans enregistrer', async () => {
    const { onSave, onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    cleanup();

    const second = setup(undefined, onSave);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(second.onClose).toHaveBeenCalledTimes(1));
    expect(onSave).not.toHaveBeenCalled();
  });
});
