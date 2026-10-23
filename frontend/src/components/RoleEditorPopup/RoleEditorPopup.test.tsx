import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { RoleEditorPopup } from './RoleEditorPopup';
import { defaultLabels } from './labels';
import type { Role, User } from './types';

// Depuis la coquille Popup (#106), la popup est portée dans document.body : le voile n'est plus
// dans le `container` du rendu. Le panneau reste l'enfant direct du voile. Un clic sur le voile ne
// ferme que s'il commence sur le voile (mousedown puis click).
const popupOverlay = () => document.body.querySelector('[data-variant]') as HTMLElement;
const clickBackdrop = (el: HTMLElement = popupOverlay()) => {
  fireEvent.mouseDown(el);
  fireEvent.click(el);
};

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

const ROLES: Role[] = [
  { id: 1, name: 'Administrateur' },
  { id: 2, name: 'Enseignant' },
];

function user(id: number, firstName: string, lastName: string, role_ids: number[]): User {
  return {
    id,
    username: `${firstName.toLowerCase()}${id}`,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}@moodit.ca`,
    avatarColor: '#0D9488',
    role_ids,
  };
}

const USERS: User[] = [
  user(10, 'Alice', 'Martin', [1]),
  user(11, 'Bob', 'Roy', [2]),
  user(12, 'Chloé', 'Dion', []),
];

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof RoleEditorPopup>> = {}) {
  const onClose = vi.fn();
  const onChange = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <RoleEditorPopup onClose={onClose} roles={ROLES} users={USERS} onChange={onChange} {...overrides} />
  );
  return { onClose, onChange, ...utils };
}

/** Section d'un rôle (data-role-id). */
function section(roleId: number) {
  return document.querySelector(`section[data-role-id="${roleId}"]`) as HTMLElement;
}
/** Titre « Rôle · n » d'une section. */
function sectionTitle(roleId: number) {
  return section(roleId).querySelector('h2')?.textContent ?? '';
}
/** Bouton « + Ajouter » d'une section (null si masqué). */
function addButton(roleId: number) {
  return Array.from(section(roleId).querySelectorAll('header button')).find((b) =>
    b.textContent?.includes(t.addButton)
  ) as HTMLButtonElement | undefined;
}
/** Noms des membres listés dans une section. */
function memberNames(roleId: number) {
  return Array.from(section(roleId).querySelectorAll(':scope > ul > li > div > div > span:first-child')).map(
    (s) => s.textContent
  );
}
/** Corbeille d'un membre de la section (null si masquée). */
function trashFor(roleId: number, fullName: string) {
  const li = Array.from(section(roleId).querySelectorAll(':scope > ul > li')).find((el) =>
    el.textContent?.includes(fullName)
  ) as HTMLElement;
  return li.querySelector('button') as HTMLButtonElement | null;
}
/** Noms des candidats du sélecteur ouvert. */
function candidateNames() {
  return Array.from(document.querySelectorAll('header ul li button div span:first-child')).map(
    (s) => s.textContent
  );
}

describe('RoleEditorPopup', () => {
  it('affiche un message quand aucun rôle n’est fourni', () => {
    renderPopup({ roles: [] });
    expect(screen.getByText(t.emptyRoles)).toBeTruthy();
  });

  it('bâtit une section par rôle avec le compte et les membres', () => {
    renderPopup();
    expect(sectionTitle(1)).toBe('Administrateur · 1');
    expect(memberNames(1)).toEqual(['Alice Martin']);
    expect(section(1).textContent).toContain('alice@moodit.ca');
    expect(section(1).textContent).toContain('AM'); // initiales
    expect(memberNames(2)).toEqual(['Bob Roy']);
  });

  it('section vide : message « aucun utilisateur pour ce rôle »', () => {
    renderPopup({ roles: [{ id: 3, name: 'Mainteneur' }] });
    expect(screen.getByText(t.emptyRole)).toBeTruthy();
    expect(sectionTitle(3)).toBe('Mainteneur · 0');
  });

  it('canAssign / canUnassign masquent le « + » et la corbeille', () => {
    renderPopup({
      canAssign: (roleId) => roleId !== 1,
      canUnassign: (roleId, userId) => !(roleId === 1 && userId === 10),
    });
    expect(addButton(1)).toBeUndefined();
    expect(addButton(2)).toBeTruthy();
    expect(trashFor(1, 'Alice Martin')).toBeNull();
    expect(trashFor(2, 'Bob Roy')).toBeTruthy();
  });

  // ── Sélecteur local ──

  it('le sélecteur liste les utilisateurs sans ce rôle, filtre et signale « aucun résultat »', () => {
    renderPopup();
    fireEvent.click(addButton(1) as HTMLButtonElement);
    expect(candidateNames()).toEqual(['Bob Roy', 'Chloé Dion']);
    const search = screen.getByPlaceholderText(t.searchPlaceholder);
    fireEvent.change(search, { target: { value: 'roy' } });
    expect(candidateNames()).toEqual(['Bob Roy']);
    fireEvent.change(search, { target: { value: 'chloé@' } }); // par courriel
    expect(candidateNames()).toEqual(['Chloé Dion']);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText(t.noResults)).toBeTruthy();
  });

  it('« aucun utilisateur disponible » quand tout le monde a déjà le rôle', () => {
    renderPopup({ users: [user(1, 'A', 'B', [1])] });
    fireEvent.click(addButton(1) as HTMLButtonElement);
    expect(screen.getByText(t.noCandidates)).toBeTruthy();
  });

  it('re-cliquer « + » ou cliquer en dehors ferme le sélecteur et vide la recherche', () => {
    renderPopup();
    fireEvent.click(addButton(1) as HTMLButtonElement);
    fireEvent.change(screen.getByPlaceholderText(t.searchPlaceholder), { target: { value: 'x' } });
    fireEvent.click(addButton(1) as HTMLButtonElement);
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
    fireEvent.click(addButton(1) as HTMLButtonElement);
    expect((screen.getByPlaceholderText(t.searchPlaceholder) as HTMLInputElement).value).toBe('');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
  });

  it('un seul sélecteur ouvert à la fois (ouvrir une section ferme l’autre)', () => {
    renderPopup();
    fireEvent.click(addButton(1) as HTMLButtonElement);
    fireEvent.click(addButton(2) as HTMLButtonElement);
    expect(screen.getAllByPlaceholderText(t.searchPlaceholder)).toHaveLength(1);
    expect(section(2).querySelector('input')).toBeTruthy();
    expect(section(1).querySelector('input')).toBeNull();
  });

  // ── Assignation ──

  it('assigner : ajout optimiste dans la section, sélecteur fermé, onChange { assign }', async () => {
    const { onChange } = renderPopup();
    fireEvent.click(addButton(1) as HTMLButtonElement);
    fireEvent.click(screen.getByText('Chloé Dion'));
    expect(screen.queryByPlaceholderText(t.searchPlaceholder)).toBeNull();
    expect(memberNames(1)).toEqual(['Alice Martin', 'Chloé Dion']);
    expect(sectionTitle(1)).toBe('Administrateur · 2');
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ type: 'assign', roleId: 1, userId: 12 })
    );
  });

  it('assigner : si onChange rejette, le rôle est retiré (rollback) + ErrorPopup', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('boom'));
    renderPopup({ onChange });
    fireEvent.click(addButton(1) as HTMLButtonElement);
    fireEvent.click(screen.getByText('Chloé Dion'));
    expect(memberNames(1)).toEqual(['Alice Martin', 'Chloé Dion']);
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(screen.getByText(t.errorTitle)).toBeTruthy();
    expect(memberNames(1)).toEqual(['Alice Martin']);
    fireEvent.click(screen.getByText(t.errorClose));
    expect(screen.queryByText(t.saveError)).toBeNull();
  });

  // ── Retrait ──

  it('retirer : retrait optimiste, onChange { unassign } ; verrou pendant l’appel', async () => {
    let resolve!: () => void;
    const onChange = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    renderPopup({ onChange });
    fireEvent.click(trashFor(1, 'Alice Martin') as HTMLButtonElement);
    expect(memberNames(1)).toEqual([]);
    expect(screen.getByText(t.emptyRole)).toBeTruthy();
    expect(onChange).toHaveBeenCalledWith({ type: 'unassign', roleId: 1, userId: 10 });
    // Pendant l'appel, les autres corbeilles sont désactivées.
    expect((trashFor(2, 'Bob Roy') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(trashFor(2, 'Bob Roy') as HTMLButtonElement);
    expect(onChange).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect((trashFor(2, 'Bob Roy') as HTMLButtonElement).disabled).toBe(false));
  });

  it('retirer : si onChange rejette, le rôle est réassigné (rollback) + ErrorPopup', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('boom'));
    renderPopup({ onChange });
    fireEvent.click(trashFor(2, 'Bob Roy') as HTMLButtonElement);
    expect(memberNames(2)).toEqual([]);
    expect(await screen.findByText(t.saveError)).toBeTruthy();
    expect(memberNames(2)).toEqual(['Bob Roy']);
  });

  it('sans onChange, les modifications restent locales', () => {
    renderPopup({ onChange: undefined });
    fireEvent.click(trashFor(2, 'Bob Roy') as HTMLButtonElement);
    expect(memberNames(2)).toEqual([]);
    fireEvent.click(addButton(2) as HTMLButtonElement);
    fireEvent.click(screen.getByText('Bob Roy'));
    expect(memberNames(2)).toEqual(['Bob Roy']);
  });

  // ── Temps réel ──

  it('subscribeUpdates : la liste reçue remplace les utilisateurs ; désabonnement au démontage', () => {
    let handler: ((users: User[]) => void) | null = null;
    const unsubscribe = vi.fn();
    const subscribeUpdates = vi.fn((h: (users: User[]) => void) => {
      handler = h;
      return unsubscribe;
    });
    const { unmount } = renderPopup({ subscribeUpdates });
    expect(subscribeUpdates).toHaveBeenCalledTimes(1);
    act(() => handler?.([user(50, 'Zoé', 'Lee', [1, 2])]));
    expect(memberNames(1)).toEqual(['Zoé Lee']);
    expect(memberNames(2)).toEqual(['Zoé Lee']);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // ── Mode serveur (candidats paginés) ──

  describe('mode serveur (loadCandidates)', () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => user(start + i, `U${start + i}`, 'Srv', []));

    it('ouvrir le sélecteur charge la 1re page (debounce 200 ms) avec spinner puis candidats', async () => {
      vi.useFakeTimers();
      const loadCandidates = vi.fn().mockResolvedValue(page(100, 3));
      renderPopup({ loadCandidates });
      fireEvent.click(addButton(1) as HTMLButtonElement);
      expect(loadCandidates).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(loadCandidates).toHaveBeenCalledWith(1, '', 0, 10);
      await act(async () => {
        await Promise.resolve();
      });
      expect(candidateNames()).toEqual(['U100 Srv', 'U101 Srv', 'U102 Srv']);
      // Les utilisateurs locaux ne sont PAS proposés en mode serveur.
      expect(screen.queryByText('Chloé Dion')).toBeNull();
    });

    it('la frappe relance la recherche côté serveur avec le texte saisi', async () => {
      vi.useFakeTimers();
      const loadCandidates = vi.fn().mockResolvedValue([]);
      renderPopup({ loadCandidates });
      fireEvent.click(addButton(1) as HTMLButtonElement);
      fireEvent.change(screen.getByPlaceholderText(t.searchPlaceholder), {
        target: { value: ' bob ' },
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      // Une seule requête (la frappe a annulé le debounce d'ouverture), avec le texte rogné.
      expect(loadCandidates).toHaveBeenCalledTimes(1);
      expect(loadCandidates).toHaveBeenCalledWith(1, 'bob', 0, 10);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(t.noResults)).toBeTruthy();
    });

    it('une page pleine active le défilement infini : la page suivante est ajoutée', async () => {
      vi.useFakeTimers();
      const loadCandidates = vi
        .fn()
        .mockResolvedValueOnce(page(100, 10))
        .mockResolvedValueOnce(page(110, 2));
      renderPopup({ loadCandidates });
      fireEvent.click(addButton(1) as HTMLButtonElement);
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(candidateNames()).toHaveLength(10);
      const list = section(1).querySelector('header ul') as HTMLUListElement;
      // jsdom : scrollHeight/clientHeight valent 0 → on est « en bas » dès le 1er scroll.
      fireEvent.scroll(list);
      expect(loadCandidates).toHaveBeenLastCalledWith(1, '', 1, 10);
      await act(async () => {
        await Promise.resolve();
      });
      expect(candidateNames()).toHaveLength(12);
      // Dernier lot < taille de page → plus rien à charger.
      fireEvent.scroll(list);
      expect(loadCandidates).toHaveBeenCalledTimes(2);
    });

    it('échec du chargement : liste vide, pas de page suivante', async () => {
      vi.useFakeTimers();
      const loadCandidates = vi.fn().mockRejectedValue(new Error('boom'));
      renderPopup({ loadCandidates });
      fireEvent.click(addButton(1) as HTMLButtonElement);
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(t.noCandidates)).toBeTruthy();
      fireEvent.scroll(section(1).querySelector('header ul') as HTMLUListElement);
      expect(loadCandidates).toHaveBeenCalledTimes(1);
    });

    it('assigner un candidat serveur l’insère dans la section (upsert) et notifie onChange', async () => {
      vi.useFakeTimers();
      const loadCandidates = vi.fn().mockResolvedValue(page(100, 1));
      const { onChange } = renderPopup({ loadCandidates });
      fireEvent.click(addButton(2) as HTMLButtonElement);
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(screen.getByText('U100 Srv'));
      expect(memberNames(2)).toEqual(['Bob Roy', 'U100 Srv']);
      expect(onChange).toHaveBeenCalledWith({ type: 'assign', roleId: 2, userId: 100 });
    });
  });

  // ── Fermeture / libellés ──

  it('« ✕ » et le voile appellent onClose', () => {
    const { onClose } = renderPopup();
    fireEvent.click(screen.getByText('✕'));
    clickBackdrop();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('surcharge des libellés via labels', () => {
    renderPopup({ labels: { title: 'Rôles du programme', addButton: 'Inviter' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Rôles du programme');
    expect(screen.getAllByText('Inviter').length).toBe(2);
  });
});
