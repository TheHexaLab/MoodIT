import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * Tests de l'étape 1 du « mot de passe oublié » (saisie de l'e-mail). `forgotPassword` est
 * mocké ; la navigation vers /reset-password (avec l'e-mail en state) est vérifiée via une sonde.
 */

const forgotPassword = vi.fn();
vi.mock('../../helpers/api', () => ({
  forgotPassword: (...a: unknown[]) => forgotPassword(...a),
}));

import ForgotPassword from './ForgotPassword';
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

function renderForgot() {
  return render(
    <ThemeContext.Provider value={{ theme: 'light', setTheme: vi.fn(), toggleTheme }}>
      <MemoryRouter initialEntries={['/forgot-password']}>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ThemeContext.Provider>
  );
}

function emailInput(): HTMLInputElement {
  return screen.getByPlaceholderText('exemple@usherbrooke.ca') as HTMLInputElement;
}
function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Envoyer le code|Envoi/ }) as HTMLButtonElement;
}

beforeEach(() => {
  forgotPassword.mockReset();
  toggleTheme.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ForgotPassword', () => {
  it('e-mail vide : erreur sur le champ, aucun appel', () => {
    renderForgot();
    fireEvent.click(submitButton());
    expect(screen.getByText('⚠ L’adresse e-mail est requise')).toBeTruthy();
    expect(emailInput().className).toContain('invalid');
    expect(forgotPassword).not.toHaveBeenCalled();
  });

  it('e-mail mal formé : erreur de format, aucun appel', () => {
    renderForgot();
    // Passe la validation native type=email, mais pas la regex de la page.
    fireEvent.change(emailInput(), { target: { value: 'k@usherbrooke' } });
    fireEvent.click(submitButton());
    expect(screen.getByText('⚠ Format d’e-mail invalide')).toBeTruthy();
    expect(forgotPassword).not.toHaveBeenCalled();
  });

  it('succès : appelle forgotPassword puis navigue vers /reset-password avec l’e-mail', async () => {
    forgotPassword.mockResolvedValueOnce({ message: 'ok' });
    renderForgot();
    fireEvent.change(emailInput(), { target: { value: 'k@usherbrooke.ca' } });
    fireEvent.click(submitButton());
    expect(forgotPassword).toHaveBeenCalledWith('k@usherbrooke.ca');
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/reset-password'));
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '')).toEqual({
      email: 'k@usherbrooke.ca',
    });
  });

  it('touche Entrée (soumission du formulaire) : déclenche l’envoi', async () => {
    forgotPassword.mockResolvedValueOnce({});
    renderForgot();
    fireEvent.change(emailInput(), { target: { value: 'k@usherbrooke.ca' } });
    fireEvent.submit(emailInput().closest('form') as HTMLFormElement);
    expect(forgotPassword).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/reset-password'));
  });

  it('pendant l’appel : bouton désactivé avec « Envoi... »', async () => {
    let resolve!: (v: unknown) => void;
    forgotPassword.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderForgot();
    fireEvent.change(emailInput(), { target: { value: 'k@usherbrooke.ca' } });
    fireEvent.click(submitButton());
    expect(submitButton().textContent).toBe('Envoi...');
    expect(submitButton().disabled).toBe(true);
    await act(async () => resolve({}));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/reset-password'));
  });

  it('erreur serveur : bandeau global, on reste sur la page', async () => {
    forgotPassword.mockRejectedValueOnce(new Error('Erreur 500'));
    renderForgot();
    fireEvent.change(emailInput(), { target: { value: 'k@usherbrooke.ca' } });
    fireEvent.click(submitButton());
    const banner = await screen.findByText('⚠ Erreur 500');
    expect(banner.className).toBe('server-error');
    expect(screen.queryByTestId('path')).toBeNull();
    expect(submitButton().disabled).toBe(false);
  });

  it('rejet non-Error : « Erreur de connexion au serveur »', async () => {
    forgotPassword.mockRejectedValueOnce(null);
    renderForgot();
    fireEvent.change(emailInput(), { target: { value: 'k@usherbrooke.ca' } });
    fireEvent.click(submitButton());
    await screen.findByText('⚠ Erreur de connexion au serveur');
  });

  it('lien « ← Retour à la connexion » : navigue vers /login', () => {
    renderForgot();
    fireEvent.click(screen.getByText('← Retour à la connexion'));
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });

  it('le bouton de thème appelle toggleTheme', () => {
    renderForgot();
    fireEvent.click(screen.getByRole('button', { name: 'Changer de thème' }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });
});
