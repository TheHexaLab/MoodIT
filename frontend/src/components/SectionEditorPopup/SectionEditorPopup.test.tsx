import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SectionEditorPopup } from './SectionEditorPopup';
import { defaultLabels } from './labels';
import { defaultLabels as deleteLabels } from '../DeleteConfirmationPopup/labels';
import type { Item, ItemChange } from './types';

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
// Les indices « ⚠ » contiennent un double espace : le normaliseur par défaut de Testing Library
// réduit les espaces du DOM mais pas ceux de la chaîne cherchée → comparaison brute.
const RAW = { normalizer: (s: string) => s };

const ITEMS: Item[] = [
  { id: 'a', name: 'general' },
  { id: 'b', name: 'devoirs' },
  { id: 'c', name: 'examens' },
];

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof SectionEditorPopup>> = {}) {
  const onClose = vi.fn();
  const onChange = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <SectionEditorPopup onClose={onClose} itemList={ITEMS} onChange={onChange} {...overrides} />
  );
  return { onClose, onChange, ...utils };
}

/** Ligne (li) d'un élément, repérée par son nom. */
function row(name: string) {
  return screen.getByText(name).closest('li') as HTMLLIElement;
}
/** Icônes d'action d'une ligne : [crayon, corbeille] (svg nus, sans rôle). */
function rowActions(name: string) {
  const svgs = row(name).querySelectorAll(':scope > div:last-child > svg');
  return { pencil: svgs[0] as SVGElement, trash: svgs[1] as SVGElement };
}
/** Noms affichés, dans l'ordre de la liste. */
function listedNames() {
  return Array.from(document.querySelectorAll('ol > li'))
    .map((li) => li.querySelector('span > span:last-child')?.textContent ?? '')
    .filter((n) => n !== '');
}
function draftInput() {
  return document.querySelector('input[type="text"]') as HTMLInputElement;
}
function saveButton() {
  return screen.getByText(t.save).closest('button') as HTMLButtonElement;
}

describe('SectionEditorPopup', () => {
  it('rend la liste (préfixe + noms) dans un portail vers body', () => {
    const { container } = renderPopup();
    expect(container.children.length).toBe(0); // rien dans le conteneur : tout est porté vers body
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t.title);
    expect(listedNames()).toEqual(['general', 'devoirs', 'examens']);
    expect(screen.getAllByText('#').length).toBe(3);
  });

  it('préfixe personnalisé et message vide', () => {
    renderPopup({ itemList: [], prefix: '@' });
    expect(screen.getByText(t.emptyMessage)).toBeTruthy();
    expect(screen.queryByText('@')).toBeNull(); // aucune ligne → aucun préfixe
    fireEvent.click(screen.getByText(t.addButton));
    expect(screen.getByText('@')).toBeTruthy();
    expect(screen.queryByText(t.emptyMessage)).toBeNull();
  });

  // ── Ajout ──

  it('ajout : saisie en minuscules, indices de validation, enregistrement désactivé si vide/doublon', () => {
    renderPopup();
    fireEvent.click(screen.getByText(t.addButton));
    expect(screen.getByText(t.addTitle)).toBeTruthy();
    expect(screen.getByText(t.hintInvalid, RAW)).toBeTruthy(); // vide → invalide
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(draftInput(), { target: { value: 'DEVOIRS' } });
    expect(draftInput().value).toBe('devoirs');
    expect(screen.getByText(t.hintDuplicate, RAW)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(draftInput(), { target: { value: 'projets' } });
    expect(screen.getByText(t.hint)).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it('ajout : onChange reçoit { create, item } et la liste n’est mise à jour qu’après succès', async () => {
    const { onChange } = renderPopup();
    fireEvent.click(screen.getByText(t.addButton));
    fireEvent.change(draftInput(), { target: { value: '  projets ' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(listedNames()).toContain('projets'));
    const change = onChange.mock.calls[0][0] as ItemChange;
    expect(change.type).toBe('create');
    if (change.type === 'create') {
      expect(change.item.name).toBe('projets');
      expect(typeof change.item.id).toBe('string');
    }
    // Le formulaire est refermé, le bouton d'ajout est de retour.
    expect(screen.getByText(t.addButton)).toBeTruthy();
  });

  it('ajout : l’id réel renvoyé par onChange remplace l’id temporaire pour les actions suivantes', async () => {
    const onChange = vi.fn(async (change: ItemChange) =>
      change.type === 'create' ? { type: 'create', item: { ...change.item, id: '42' } } : undefined
    );
    renderPopup({ onChange });
    fireEvent.click(screen.getByText(t.addButton));
    fireEvent.change(draftInput(), { target: { value: 'projets' } });
    fireEvent.keyDown(draftInput(), { key: 'Enter' }); // Entrée enregistre
    await waitFor(() => expect(listedNames()).toContain('projets'));
    // Renommage enchaîné : doit envoyer l'id réel « 42 ».
    fireEvent.click(rowActions('projets').pencil);
    fireEvent.change(draftInput(), { target: { value: 'projets-2' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(listedNames()).toContain('projets-2'));
    expect(onChange).toHaveBeenLastCalledWith({ type: 'rename', id: '42', name: 'projets-2' });
  });

  it('ajout : Échap ou « Annuler » referme le formulaire sans appeler onChange', () => {
    const { onChange } = renderPopup();
    fireEvent.click(screen.getByText(t.addButton));
    fireEvent.change(draftInput(), { target: { value: 'x' } });
    fireEvent.keyDown(draftInput(), { key: 'Escape' });
    expect(screen.queryByText(t.addTitle)).toBeNull();
    fireEvent.click(screen.getByText(t.addButton));
    fireEvent.click(screen.getByText(t.cancel));
    expect(screen.queryByText(t.addTitle)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ajout : si onChange rejette, ErrorPopup + saisie conservée, liste inchangée', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('boom'));
    renderPopup({ onChange });
    fireEvent.click(screen.getByText(t.addButton));
    fireEvent.change(draftInput(), { target: { value: 'projets' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(draftInput().value).toBe('projets');
    expect(listedNames()).toEqual(['general', 'devoirs', 'examens']);
    fireEvent.click(screen.getByText(t.errorClose));
    expect(screen.queryByText(t.saveError)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('sans onChange, l’ajout fonctionne localement', async () => {
    renderPopup({ onChange: undefined });
    fireEvent.click(screen.getByText(t.addButton));
    fireEvent.change(draftInput(), { target: { value: 'local' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(listedNames()).toContain('local'));
  });

  // ── Renommage ──

  it('renommage : pré-remplit, autorise le même nom que soi, bloque un nom existant', async () => {
    const { onChange } = renderPopup();
    fireEvent.click(rowActions('devoirs').pencil);
    expect(screen.getByText(t.editTitle)).toBeTruthy();
    expect(draftInput().value).toBe('devoirs');
    expect(saveButton().disabled).toBe(false); // son propre nom n'est pas un doublon
    fireEvent.change(draftInput(), { target: { value: 'general' } });
    expect(screen.getByText(t.hintDuplicate, RAW)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(draftInput(), { target: { value: 'travaux' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(listedNames()).toEqual(['general', 'travaux', 'examens']));
    expect(onChange).toHaveBeenCalledWith({ type: 'rename', id: 'b', name: 'travaux' });
  });

  it('renommage : ouvrir le crayon d’une autre ligne remplace le formulaire', () => {
    renderPopup();
    fireEvent.click(rowActions('devoirs').pencil);
    expect(draftInput().value).toBe('devoirs');
    fireEvent.click(rowActions('examens').pencil);
    expect(draftInput().value).toBe('examens');
    expect(document.querySelectorAll('input[type="text"]').length).toBe(1);
  });

  // ── Suppression ──

  it('suppression : confirmation puis onChange { delete, id } ; annuler ne supprime pas', async () => {
    const { onChange } = renderPopup();
    fireEvent.click(rowActions('devoirs').trash);
    expect(screen.getByText(t.deleteTitle)).toBeTruthy();
    expect(screen.getByText(t.deleteBody(ITEMS[1]))).toBeTruthy();
    fireEvent.click(screen.getByText(deleteLabels.cancel));
    expect(screen.queryByText(t.deleteTitle)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(rowActions('devoirs').trash);
    fireEvent.click(screen.getByText(deleteLabels.confirm));
    expect(listedNames()).toEqual(['general', 'examens']); // optimiste
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ type: 'delete', id: 'b' }));
  });

  it('suppression : si onChange rejette, l’élément est réinséré à sa place + ErrorPopup', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('boom'));
    renderPopup({ onChange });
    fireEvent.click(rowActions('devoirs').trash);
    fireEvent.click(screen.getByText(deleteLabels.confirm));
    expect(listedNames()).toEqual(['general', 'examens']);
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(listedNames()).toEqual(['general', 'devoirs', 'examens']);
  });

  // ── Réordonnancement ──

  it('glisser-déposer : onChange { reorder, orderedIds } avec le nouvel ordre', async () => {
    const { onChange } = renderPopup();
    const first = row('general');
    fireEvent.mouseDown(first.querySelector('span') as HTMLElement); // poignée → draggable
    expect(first.getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(first);
    fireEvent.dragEnter(row('examens'));
    expect(listedNames()).toEqual(['devoirs', 'examens', 'general']);
    fireEvent.dragEnd(row('general'));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ type: 'reorder', orderedIds: ['b', 'c', 'a'] })
    );
    expect(row('general').getAttribute('draggable')).toBe('false');
  });

  it('glisser-déposer sans changement d’ordre : aucun onChange', () => {
    const { onChange } = renderPopup();
    const first = row('general');
    fireEvent.dragStart(first);
    fireEvent.dragEnter(first);
    fireEvent.dragEnd(first);
    expect(onChange).not.toHaveBeenCalled();
    expect(listedNames()).toEqual(['general', 'devoirs', 'examens']);
  });

  it('glisser-déposer : si onChange rejette, l’ordre initial est rétabli', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('boom'));
    renderPopup({ onChange });
    fireEvent.dragStart(row('general'));
    fireEvent.dragEnter(row('devoirs'));
    fireEvent.dragEnd(row('general'));
    expect(listedNames()).toEqual(['devoirs', 'general', 'examens']);
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(listedNames()).toEqual(['general', 'devoirs', 'examens']);
  });

  // ── Fermeture / libellés ──

  it('« ✕ » et le voile appellent onClose', () => {
    const { onClose } = renderPopup();
    fireEvent.click(screen.getByText('✕'));
    const scrim = screen.getByRole('heading', { level: 1 }).closest('div')
      ?.parentElement?.parentElement?.parentElement as HTMLElement;
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('surcharge des libellés via labels', () => {
    renderPopup({ labels: { title: 'Canaux', addButton: 'Nouveau canal' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Canaux');
    expect(screen.getByText('Nouveau canal')).toBeTruthy();
  });
});
