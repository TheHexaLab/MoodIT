import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * Tests de la page d'inscription. `register` (helpers/api) est mocké, le thème vient d'un
 * ThemeContext factice, et la navigation est vérifiée via une sonde rendue sur la route cible.
 */

const register = vi.fn();
vi.mock('../../helpers/api', () => ({
  register: (...a: unknown[]) => register(...a),
}));

import Register from './Register';
import { ThemeContext } from '../../context/themeContext';

const toggleTheme = vi.fn();

function LocationProbe() {
  const location = useLocation();
  return (
    <div>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="state">{JSON.stringify(location.state)}</span>
    </div>
  );
}

function renderRegister() {
  return render(
    <ThemeContext.Provider value={{ theme: 'dark', setTheme: vi.fn(), toggleTheme }}>
      <MemoryRouter initialEntries={['/register']}>
        <Routes>
          <Route path="/register" element={<Register />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ThemeContext.Provider>
  );
}

const PLACEHOLDERS = {
  username: 'ex : RKarine',
  firstName: 'ex: Karine',
  lastName: 'ex: Roussel',
  email: 'ex: Karine_Roussel@usherbrooke.ca',
  password: 'Choisissez un mot de passe',
  confirm: 'Retapez votre mot de passe',
} as const;

function input(key: keyof typeof PLACEHOLDERS): HTMLInputElement {
  return screen.getByPlaceholderText(PLACEHOLDERS[key]) as HTMLInputElement;
}
function type(key: keyof typeof PLACEHOLDERS, value: string) {
  fireEvent.change(input(key), { target: { value } });
}
function termsCheckbox(): HTMLInputElement {
  return screen.getByRole('checkbox') as HTMLInputElement;
}
function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Créer mon compte|Création/ }) as HTMLButtonElement;
}

const VALID = {
  username: 'rkarine',
  firstName: 'Karine',
  lastName: 'Roussel',
  email: 'k@usherbrooke.ca',
  password: 'Secret123!',
};

/** Remplit un formulaire valide (conditions acceptées). */
function fillValid() {
  type('username', VALID.username);
  type('firstName', VALID.firstName);
  type('lastName', VALID.lastName);
  type('email', VALID.email);
  type('password', VALID.password);
  type('confirm', VALID.password);
  fireEvent.click(termsCheckbox());
}

/** Libellé de force affiché à côté du mot de passe (null si absent). */
function strengthLabel(): HTMLElement | null {
  return screen.queryByText(/^Mot de passe (trop court|faible|moyen|fort)$/);
}

beforeEach(() => {
  register.mockReset();
  toggleTheme.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Register', () => {
  it('formulaire vide : « Requis » sur chaque champ + conditions, aucun appel', () => {
    renderRegister();
    fireEvent.click(submitButton());
    expect(screen.getAllByText('⚠ Requis')).toHaveLength(6);
    expect(screen.getByText("⚠ Vous devez accepter les conditions d'utilisation")).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
  });

  it('e-mail mal formé : erreur de format', () => {
    renderRegister();
    fillValid();
    type('email', 'pas-un-email');
    fireEvent.click(submitButton());
    expect(screen.getByText('⚠ Format d’e-mail invalide')).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
  });

  it('mot de passe de moins de 8 caractères : refusé comme trop faible', () => {
    renderRegister();
    fillValid();
    type('password', 'abc');
    type('confirm', 'abc');
    fireEvent.click(submitButton());
    expect(screen.getByText('⚠ Mot de passe trop faible')).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
  });

  it('confirmation différente : indicateur immédiat puis erreur à la soumission', () => {
    renderRegister();
    fillValid();
    type('confirm', 'Autre123!');
    // Indicateur en direct, avant même la soumission.
    expect(screen.getByText('⚠ Les mots de passe ne correspondent pas')).toBeTruthy();
    fireEvent.click(submitButton());
    expect(screen.getAllByText('⚠ Les mots de passe ne correspondent pas')).toHaveLength(1);
    expect(register).not.toHaveBeenCalled();
  });

  it('conditions non acceptées : erreur dédiée, aucun appel', () => {
    renderRegister();
    fillValid();
    fireEvent.click(termsCheckbox()); // décoche
    fireEvent.click(submitButton());
    expect(screen.getByText("⚠ Vous devez accepter les conditions d'utilisation")).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    ['abc', 'Mot de passe trop court', '1'],
    ['abcdefgh', 'Mot de passe faible', '2'],
    ['abcdefg1', 'Mot de passe moyen', '3'],
    ['abcdefg!', 'Mot de passe moyen', '3'],
    ['abcdef1!', 'Mot de passe fort', '4'],
  ])('force du mot de passe « %s » → %s (niveau %s)', (pw, label, level) => {
    renderRegister();
    type('password', pw);
    const el = strengthLabel();
    expect(el?.textContent).toBe(label);
    expect(el?.getAttribute('data-level')).toBe(level);
  });

  it('aucun indicateur de force tant que le mot de passe est vide', () => {
    renderRegister();
    expect(strengthLabel()).toBeNull();
  });

  it('succès : envoie le profil (sans confirmation) et navigue vers /verify-code mode email', async () => {
    register.mockResolvedValueOnce({ message: 'ok' });
    renderRegister();
    fillValid();
    fireEvent.click(submitButton());
    expect(register).toHaveBeenCalledWith(VALID);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/verify-code'));
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '')).toEqual({
      email: VALID.email,
      mode: 'email',
    });
  });

  it('pendant l’appel : bouton désactivé avec « Création... »', async () => {
    let resolve!: (v: unknown) => void;
    register.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderRegister();
    fillValid();
    fireEvent.click(submitButton());
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe('Création...');
    await act(async () => resolve({}));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/verify-code'));
  });

  it.each([
    ["Nom d'utilisateur déjà pris", 'username'],
    ['Adresse e-mail déjà utilisée', 'email'],
    ['Mot de passe refusé', 'password'],
  ])('erreur serveur « %s » : rattachée au champ %s', async (message, field) => {
    register.mockRejectedValueOnce(new Error(message));
    renderRegister();
    fillValid();
    fireEvent.click(submitButton());
    await screen.findByText(`⚠ ${message}`);
    const wrap = input(field as keyof typeof PLACEHOLDERS).parentElement as HTMLElement;
    // Le conteneur du champ reçoit la classe « invalid » (CSS module : nom suffixé).
    expect(wrap.className).toMatch(/invalid/);
    expect(submitButton().disabled).toBe(false);
  });

  it('erreur générale : bandeau global, on reste sur la page', async () => {
    register.mockRejectedValueOnce(new Error('Erreur 503'));
    renderRegister();
    fillValid();
    fireEvent.click(submitButton());
    await screen.findByText('⚠ Erreur 503');
    expect(screen.queryByTestId('path')).toBeNull();
  });

  it('rejet non-Error : « Erreur inconnue »', async () => {
    register.mockRejectedValueOnce(42);
    renderRegister();
    fillValid();
    fireEvent.click(submitButton());
    await screen.findByText('⚠ Erreur inconnue');
  });

  it('les boutons œil basculent chaque champ mot de passe indépendamment', () => {
    renderRegister();
    const [eyePw, eyeConfirm] = screen.getAllByRole('button', {
      name: 'Afficher le mot de passe',
    });
    fireEvent.click(eyePw);
    expect(input('password').type).toBe('text');
    expect(input('confirm').type).toBe('password');
    expect(eyePw.getAttribute('aria-label')).toBe('Masquer le mot de passe');
    fireEvent.click(eyeConfirm);
    expect(input('confirm').type).toBe('text');
    fireEvent.click(eyePw);
    expect(input('password').type).toBe('password');
  });

  it('le bouton « Changer de thème » appelle toggleTheme', () => {
    renderRegister();
    fireEvent.click(screen.getByRole('button', { name: 'Changer de thème' }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  it('lien « Se connecter » : navigue vers /login', () => {
    renderRegister();
    fireEvent.click(screen.getByText('Se connecter'));
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });

  // BOGUE : contrairement aux autres pages d'authentification, Register n'a pas de <form> (le
  // bouton est type="button" avec onClick) : la touche Entrée dans un champ ne soumet rien.
  it.fails('Entrée dans un champ soumet l’inscription', () => {
    register.mockResolvedValueOnce({});
    renderRegister();
    fillValid();
    const form = input('confirm').closest('form');
    if (form) fireEvent.submit(form);
    else fireEvent.keyDown(input('confirm'), { key: 'Enter' });
    expect(register).toHaveBeenCalledTimes(1);
  });
});
