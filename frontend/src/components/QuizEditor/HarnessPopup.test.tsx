import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { HarnessBody } from './HarnessPopup';
import { EditorShell } from './EditorShell';
import { defaultHarnessLabels } from './harnessLabels';
import { type TestCaseDraft } from './editorTypes';
import { type Language } from '../../types/domain';
import './editorTestSetup';

afterEach(cleanup);

const JS: Language = { id: 2, name: 'JavaScript' };

/**
 * Le corps du harnais rend sa barre d'actions (Enregistrer/Annuler) via `EditorFooter`,
 * un portail vers le pied de la coquille (`EditorShell`). On monte donc le corps DANS
 * une coquille minimale pour que ces boutons existent.
 */
function renderHarness(
  overrides: Partial<React.ComponentProps<typeof HarnessBody>> = {}
) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const props: React.ComponentProps<typeof HarnessBody> = {
    testCases: [],
    harnessLanguage: JS,
    defaultHarnessCode: '// stub\n',
    onCancel,
    onSave,
    ...overrides,
  };
  const utils = render(
    <EditorShell title="Harnais" onClose={() => {}}>
      <HarnessBody {...props} />
    </EditorShell>
  );
  return { onSave, onCancel, ...utils };
}

const t = defaultHarnessLabels;

describe('HarnessBody', () => {
  it('affiche le bandeau contrat', () => {
    renderHarness();
    expect(screen.getByText(t.infoBanner)).toBeTruthy();
  });

  it('démarre sans carte de harnais quand la liste est vide', () => {
    renderHarness({ testCases: [] });
    expect(screen.queryByPlaceholderText(t.namePlaceholder)).toBeNull();
  });

  it('reflète les harnais existants', () => {
    const cases: TestCaseDraft[] = [
      { id: 1, name: 'Cas A', harnessCode: 'codeA', weight: 3 },
      { id: 2, name: 'Cas B', harnessCode: 'codeB', weight: 1 },
    ];
    renderHarness({ testCases: cases });
    const names = screen.getAllByPlaceholderText(t.namePlaceholder) as HTMLInputElement[];
    expect(names.map((n) => n.value)).toEqual(['Cas A', 'Cas B']);
  });

  it('« Ajouter » insère une carte avec le squelette par défaut et poids 1', () => {
    renderHarness({ defaultHarnessCode: '// SKELETON\n' });
    fireEvent.click(screen.getByText(`+ ${t.add}`));
    const names = screen.getAllByPlaceholderText(t.namePlaceholder) as HTMLInputElement[];
    expect(names).toHaveLength(1);
    expect(names[0].value).toBe('');
    // le code du harnais reçoit le squelette
    const code = screen.getByLabelText(t.codeAria(1)) as HTMLTextAreaElement;
    expect(code.value).toBe('// SKELETON\n');
  });

  it('bouton Enregistrer désactivé sans harnais', () => {
    renderHarness({ testCases: [] });
    const save = screen.getByText(t.save).closest('button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('bouton Enregistrer désactivé si un nom est vide', () => {
    renderHarness({ testCases: [{ id: 1, name: '', harnessCode: 'c', weight: 1 }] });
    const save = screen.getByText(t.save).closest('button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('devient valide une fois le nom saisi', () => {
    renderHarness({ testCases: [{ id: 1, name: '', harnessCode: 'c', weight: 1 }] });
    const save = screen.getByText(t.save).closest('button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(t.namePlaceholder), {
      target: { value: 'Cas nominal' },
    });
    expect(save.disabled).toBe(false);
  });

  it('onSave remonte les harnais édités (nom + code)', () => {
    const { onSave } = renderHarness({
      testCases: [{ id: 1, name: 'A', harnessCode: 'old', weight: 2 }],
    });
    fireEvent.change(screen.getByPlaceholderText(t.namePlaceholder), {
      target: { value: 'A modifié' },
    });
    fireEvent.change(screen.getByLabelText(t.codeAria(1)), { target: { value: 'new code' } });
    fireEvent.click(screen.getByText(t.save));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as TestCaseDraft[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 1, name: 'A modifié', harnessCode: 'new code', weight: 2 });
  });

  it('supprimer une carte la retire de la liste', () => {
    renderHarness({
      testCases: [
        { id: 1, name: 'A', harnessCode: 'a', weight: 1 },
        { id: 2, name: 'B', harnessCode: 'b', weight: 1 },
      ],
    });
    const deleteButtons = screen.getAllByLabelText(t.deleteAria);
    fireEvent.click(deleteButtons[0]);
    const names = screen.getAllByPlaceholderText(t.namePlaceholder) as HTMLInputElement[];
    expect(names.map((n) => n.value)).toEqual(['B']);
  });

  it('onCancel appelé sans mutation externe (édition non appliquée)', () => {
    const { onCancel, onSave } = renderHarness({
      testCases: [{ id: 1, name: 'A', harnessCode: 'a', weight: 1 }],
    });
    fireEvent.change(screen.getByPlaceholderText(t.namePlaceholder), {
      target: { value: 'Modifié mais annulé' },
    });
    fireEvent.click(screen.getByText(t.cancel));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('onRequestLanguages appelé au montage (contexte Code)', () => {
    const onRequestLanguages = vi.fn();
    renderHarness({ onRequestLanguages });
    expect(onRequestLanguages).toHaveBeenCalled();
  });

  describe('WeightInput (poids)', () => {
    it('marque le champ invalide quand vidé et bloque l\'enregistrement', () => {
      renderHarness({ testCases: [{ id: 1, name: 'A', harnessCode: 'a', weight: 2 }] });
      const weightInput = screen.getByText(t.weightLabel).parentElement?.querySelector(
        'input'
      ) as HTMLInputElement;
      fireEvent.focus(weightInput);
      fireEvent.change(weightInput, { target: { value: '' } });
      expect(weightInput.getAttribute('aria-invalid')).toBe('true');
      const save = screen.getByText(t.save).closest('button') as HTMLButtonElement;
      expect(save.disabled).toBe(true);
    });

    it('borne le poids à un entier ≥ 1 au blur', () => {
      const { onSave } = renderHarness({
        testCases: [{ id: 1, name: 'A', harnessCode: 'a', weight: 2 }],
      });
      const weightInput = screen.getByText(t.weightLabel).parentElement?.querySelector(
        'input'
      ) as HTMLInputElement;
      fireEvent.focus(weightInput);
      fireEvent.change(weightInput, { target: { value: '3.9' } });
      fireEvent.blur(weightInput);
      // tronqué à 3
      expect(weightInput.value).toBe('3');
      fireEvent.click(screen.getByText(t.save));
      expect((onSave.mock.calls[0][0] as TestCaseDraft[])[0].weight).toBe(3);
    });

    it('remonte 0 (bloquant) tant que le champ est vide', () => {
      renderHarness({ testCases: [{ id: 1, name: 'A', harnessCode: 'a', weight: 2 }] });
      const weightInput = screen.getByText(t.weightLabel).parentElement?.querySelector(
        'input'
      ) as HTMLInputElement;
      fireEvent.focus(weightInput);
      fireEvent.change(weightInput, { target: { value: '' } });
      const save = screen.getByText(t.save).closest('button') as HTMLButtonElement;
      expect(save.disabled).toBe(true);
    });
  });
});
