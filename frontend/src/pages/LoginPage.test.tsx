import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * Tests de la page de connexion. L'appel réseau `login` (helpers/api) est mocké ; le thème
 * est fourni par un ThemeContext factice. La navigation est vérifiée en rendant la route
 * cible (sonde qui affiche le chemin et le state reçu).
 */

const login = vi.fn();
vi.mock('../helpers/api', () => ({
  login: (...a: unknown[]) => login(...a),
}));

import LoginPage from './LoginPage';
import { ThemeContext } from '../context/themeContext';

const toggleTheme = vi.fn();

/** Sonde de route : affiche le chemin courant et le state de navigation. */
function LocationProbe() {
  const location = useLocation();
  return (
    <div>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="state">{JSON.stringify(location.state)}</span>
    </div>
  );
}

function renderLogin() {
  return render(
    <ThemeContext.Provider value={{ theme: 'light', setTheme: vi.fn(), toggleTheme }}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ThemeContext.Provider>
  );
}

function emailInput(): HTMLInputElement {
  return screen.getByPlaceholderText('exemple@gmail.com') as HTMLInputElement;
}
function passwordInput(): HTMLInputElement {
  return screen.getByPlaceholderText('••••••••••') as HTMLInputElement;
}
function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Se connecter|Connexion/ }) as HTMLButtonElement;
}

function fill(email: string, password: string) {
  fireEvent.change(emailInput(), { target: { value: email } });
  fireEvent.change(passwordInput(), { target: { value: password } });
}

beforeEach(() => {
  login.mockReset();
  toggleTheme.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('LoginPage', () => {
  it('affiche le formulaire de connexion', () => {
    renderLogin();
    expect(screen.getByText('Bon retour 👋')).toBeTruthy();
    expect(emailInput().type).toBe('email');
    expect(passwordInput().type).toBe('password');
    expect(submitButton().textContent).toBe('Se connecter →');
  });

  it('formulaire vide : erreurs sur les deux champs, aucun appel réseau', () => {
    renderLogin();
    fireEvent.click(submitButton());
    expect(screen.getByText('⚠ L’adresse e-mail est requise')).toBeTruthy();
    expect(screen.getByText('⚠ Le mot de passe est requis')).toBeTruthy();
    expect(emailInput().className).toContain('invalid');
    expect(passwordInput().className).toContain('invalid');
    expect(login).not.toHaveBeenCalled();
  });

  it('format d’e-mail invalide : erreur sur l’e-mail seulement', () => {
    renderLogin();
    // « k@usherbrooke » passe la validation native type=email mais pas la regex de la page.
    fill('k@usherbrooke', 'secret');
    fireEvent.click(submitButton());
    expect(screen.getByText('⚠ Format d’e-mail invalide')).toBeTruthy();
    expect(screen.queryByText('⚠ Le mot de passe est requis')).toBeNull();
    expect(login).not.toHaveBeenCalled();
  });

  it('succès : appelle login puis navigue vers /verify-code en mode 2fa', async () => {
    login.mockResolvedValueOnce({ username: 'k' });
    renderLogin();
    fill('k@usherbrooke.ca', 'secret');
    fireEvent.click(submitButton());
    expect(login).toHaveBeenCalledWith({ email: 'k@usherbrooke.ca', password: 'secret' });
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/verify-code'));
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '')).toEqual({
      email: 'k@usherbrooke.ca',
      mode: '2fa',
    });
  });

  it('touche Entrée (soumission du formulaire) : déclenche aussi la connexion', async () => {
    login.mockResolvedValueOnce({});
    renderLogin();
    fill('k@usherbrooke.ca', 'secret');
    // Entrée dans un champ = soumission implicite du <form> (non simulée par jsdom).
    fireEvent.submit(passwordInput().closest('form') as HTMLFormElement);
    expect(login).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/verify-code'));
  });

  it('pendant l’appel : bouton désactivé avec « Connexion... »', async () => {
    let resolve!: (v: unknown) => void;
    login.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderLogin();
    fill('k@usherbrooke.ca', 'secret');
    fireEvent.click(submitButton());
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe('Connexion...');
    await act(async () => resolve({}));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/verify-code'));
  });

  it('erreur serveur sur le mot de passe : affichée sous le champ mot de passe', async () => {
    login.mockRejectedValueOnce(new Error('Mot de passe incorrect'));
    renderLogin();
    fill('k@usherbrooke.ca', 'mauvais');
    fireEvent.click(submitButton());
    await screen.findByText('⚠ Mot de passe incorrect');
    expect(passwordInput().className).toContain('invalid');
    expect(emailInput().className).not.toContain('invalid');
    expect(document.querySelector('.server-error')).toBeNull();
    // Le bouton redevient utilisable après l'échec.
    expect(submitButton().disabled).toBe(false);
  });

  it('erreur serveur sur l’e-mail : affichée sous le champ e-mail', async () => {
    login.mockRejectedValueOnce(new Error('Courriel non vérifié'));
    renderLogin();
    fill('k@usherbrooke.ca', 'secret');
    fireEvent.click(submitButton());
    await screen.findByText('⚠ Courriel non vérifié');
    expect(emailInput().className).toContain('invalid');
  });

  it('erreur générale : bandeau global, on reste sur /login', async () => {
    login.mockRejectedValueOnce(new Error('Erreur 500'));
    renderLogin();
    fill('k@usherbrooke.ca', 'secret');
    fireEvent.click(submitButton());
    const banner = await screen.findByText('⚠ Erreur 500');
    expect(banner.className).toBe('server-error');
    expect(screen.queryByTestId('path')).toBeNull();
  });

  it('erreur « utilisateur » (pas de champ dédié ici) : bandeau global', async () => {
    login.mockRejectedValueOnce(new Error('Utilisateur bloqué'));
    renderLogin();
    fill('k@usherbrooke.ca', 'secret');
    fireEvent.click(submitButton());
    const banner = await screen.findByText('⚠ Utilisateur bloqué');
    expect(banner.className).toBe('server-error');
  });

  it('rejet non-Error : message « Erreur inconnue »', async () => {
    login.mockRejectedValueOnce('boom');
    renderLogin();
    fill('k@usherbrooke.ca', 'secret');
    fireEvent.click(submitButton());
    await screen.findByText('⚠ Erreur inconnue');
  });

  it('une nouvelle soumission efface les erreurs précédentes', async () => {
    login.mockRejectedValueOnce(new Error('Erreur 500')).mockResolvedValueOnce({});
    renderLogin();
    fill('k@usherbrooke.ca', 'secret');
    fireEvent.click(submitButton());
    await screen.findByText('⚠ Erreur 500');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/verify-code'));
  });

  it('le bouton œil bascule l’affichage du mot de passe', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Afficher le mot de passe' }));
    expect(passwordInput().type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Masquer le mot de passe' }));
    expect(passwordInput().type).toBe('password');
  });

  it('le bouton de thème appelle toggleTheme', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Changer de thème' }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  it('lien « Mot de passe oublié ? » : navigue vers /forgot-password', () => {
    renderLogin();
    fireEvent.click(screen.getByText('Mot de passe oublié ?'));
    expect(screen.getByTestId('path').textContent).toBe('/forgot-password');
  });

  it('lien « Créer un compte » : navigue vers /register', () => {
    renderLogin();
    fireEvent.click(screen.getByText('Créer un compte'));
    expect(screen.getByTestId('path').textContent).toBe('/register');
  });
});
