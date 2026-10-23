import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * Tests de l'étape 2 du « mot de passe oublié » : code reçu + nouveau mot de passe.
 * `resetPassword` et `forgotPassword` (renvoi du code) sont mockés ; l'e-mail arrive par le
 * state de navigation ; le cooldown du renvoi est piloté par des faux timers.
 */

const resetPassword = vi.fn();
const forgotPassword = vi.fn();
vi.mock('../../helpers/api', () => ({
  resetPassword: (...a: unknown[]) => resetPassword(...a),
  forgotPassword: (...a: unknown[]) => forgotPassword(...a),
}));

import ResetPassword from './ResetPassword';
import { ThemeContext } from '../../context/themeContext';

const toggleTheme = vi.fn();
const EMAIL = 'k@usherbrooke.ca';
const STRONG = 'Nouveau1!';

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

function renderReset(state: unknown = { email: EMAIL }) {
  return render(
    <ThemeContext.Provider value={{ theme: 'light', setTheme: vi.fn(), toggleTheme }}>
      <MemoryRouter initialEntries={[{ pathname: '/reset-password', state }]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ThemeContext.Provider>
  );
}

function boxes(): HTMLInputElement[] {
  return Array.from({ length: 6 }, (_, i) => screen.getByLabelText(`Chiffre ${i + 1}`)) as
    HTMLInputElement[];
}
function pasteCode(text: string) {
  fireEvent.paste(boxes()[0], { clipboardData: { getData: () => text } });
}
function passwordInputs(): [HTMLInputElement, HTMLInputElement] {
  const [pw, confirm] = screen.getAllByPlaceholderText('••••••••••') as HTMLInputElement[];
  return [pw, confirm];
}
function typePasswords(pw: string, confirm: string) {
  const [p, c] = passwordInputs();
  fireEvent.change(p, { target: { value: pw } });
  fireEvent.change(c, { target: { value: confirm } });
}
function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Réinitialis/ }) as HTMLButtonElement;
}
function resendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^(Renvoyer|Envoi)/ }) as HTMLButtonElement;
}
function errorBanner(): string | null {
  return document.querySelector('.server-error')?.textContent ?? null;
}

beforeEach(() => {
  resetPassword.mockReset();
  forgotPassword.mockReset();
  toggleTheme.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ResetPassword', () => {
  it('accès direct sans e-mail : redirige vers /forgot-password', () => {
    renderReset(null);
    expect(screen.getByTestId('path').textContent).toBe('/forgot-password');
  });

  it('affiche le formulaire de réinitialisation', () => {
    renderReset();
    expect(screen.getByText('Réinitialiser le mot de passe')).toBeTruthy();
    expect(boxes()).toHaveLength(6);
    expect(passwordInputs().every((i) => i.type === 'password')).toBe(true);
  });

  it('code incomplet : erreur et cases du code en erreur, aucun appel', () => {
    renderReset();
    const classBefore = boxes()[0].className;
    pasteCode('123');
    typePasswords(STRONG, STRONG);
    fireEvent.click(submitButton());
    expect(errorBanner()).toBe('⚠ Le code doit contenir 6 chiffres');
    expect(boxes()[0].className).not.toBe(classBefore);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('le collage d’un code complet ne soumet pas automatiquement', () => {
    renderReset();
    pasteCode('123456');
    expect(boxes().map((b) => b.value).join('')).toBe('123456');
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it.each([
    ['', '', '⚠ Le mot de passe est requis'],
    ['abc', 'abc', '⚠ Mot de passe trop faible'],
    [STRONG, 'Autre1!xx', '⚠ Les mots de passe ne correspondent pas'],
  ])(
    'mot de passe « %s » / confirmation « %s » : %s, code non surligné',
    (pw, confirm, message) => {
      renderReset();
      pasteCode('123456');
      const classBefore = boxes()[0].className;
      typePasswords(pw, confirm);
      fireEvent.click(submitButton());
      expect(errorBanner()).toBe(message);
      // L'erreur ne concerne pas le code : ses cases ne sont pas marquées en erreur.
      expect(boxes()[0].className).toBe(classBefore);
      expect(resetPassword).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['abc', 'Mot de passe trop court', '1'],
    ['abcdefgh', 'Mot de passe faible', '2'],
    ['abcdefg1', 'Mot de passe moyen', '3'],
    ['abcdef1!', 'Mot de passe fort', '4'],
  ])('force du mot de passe « %s » → %s (niveau %s)', (pw, label, level) => {
    renderReset();
    fireEvent.change(passwordInputs()[0], { target: { value: pw } });
    const el = screen.getByText(label);
    expect(el.getAttribute('data-level')).toBe(level);
  });

  it('confirmation différente : avertissement immédiat sous le champ', () => {
    renderReset();
    typePasswords(STRONG, 'Nouv');
    expect(screen.getByText('Les mots de passe ne correspondent pas')).toBeTruthy();
    typePasswords(STRONG, STRONG);
    expect(screen.queryByText('Les mots de passe ne correspondent pas')).toBeNull();
  });

  it('succès : appelle resetPassword puis affiche l’écran de confirmation', async () => {
    resetPassword.mockResolvedValueOnce({ message: 'ok' });
    renderReset();
    pasteCode('123456');
    typePasswords(STRONG, STRONG);
    fireEvent.click(submitButton());
    expect(resetPassword).toHaveBeenCalledWith(EMAIL, '123456', STRONG);
    await screen.findByText('Mot de passe réinitialisé ✅');
    // Le formulaire a disparu ; le lien mène à la connexion.
    expect(screen.queryByLabelText('Chiffre 1')).toBeNull();
    fireEvent.click(screen.getByText('Se connecter →'));
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });

  it('touche Entrée (soumission du formulaire) : déclenche la réinitialisation', async () => {
    resetPassword.mockResolvedValueOnce({});
    renderReset();
    pasteCode('123456');
    typePasswords(STRONG, STRONG);
    fireEvent.submit(passwordInputs()[1].closest('form') as HTMLFormElement);
    expect(resetPassword).toHaveBeenCalledTimes(1);
    await screen.findByText('Mot de passe réinitialisé ✅');
  });

  it('pendant l’appel : bouton « Réinitialisation... » et cases désactivés', async () => {
    let resolve!: (v: unknown) => void;
    resetPassword.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderReset();
    pasteCode('123456');
    typePasswords(STRONG, STRONG);
    fireEvent.click(submitButton());
    expect(submitButton().textContent).toBe('Réinitialisation...');
    expect(submitButton().disabled).toBe(true);
    expect(boxes().every((b) => b.disabled)).toBe(true);
    await act(async () => resolve({}));
    await screen.findByText('Mot de passe réinitialisé ✅');
  });

  it('refus serveur : message affiché et cases du code surlignées', async () => {
    resetPassword.mockRejectedValueOnce(new Error('Code expiré'));
    renderReset();
    pasteCode('123456');
    const classBefore = boxes()[0].className;
    typePasswords(STRONG, STRONG);
    fireEvent.click(submitButton());
    await waitFor(() => expect(errorBanner()).toBe('⚠ Code expiré'));
    expect(boxes()[0].className).not.toBe(classBefore);
    expect(submitButton().disabled).toBe(false);
  });

  it('rejet non-Error : « Erreur de connexion au serveur »', async () => {
    resetPassword.mockRejectedValueOnce({});
    renderReset();
    pasteCode('123456');
    typePasswords(STRONG, STRONG);
    fireEvent.click(submitButton());
    await waitFor(() => expect(errorBanner()).toBe('⚠ Erreur de connexion au serveur'));
  });

  it('renvoi : forgotPassword(email), message neutre et cooldown de 60 s', async () => {
    vi.useFakeTimers();
    forgotPassword.mockResolvedValueOnce({});
    renderReset();
    await act(async () => {
      fireEvent.click(resendButton());
    });
    expect(forgotPassword).toHaveBeenCalledWith(EMAIL);
    expect(screen.getByText('Si un compte existe, un nouveau code a été envoyé.')).toBeTruthy();
    expect(resendButton().textContent).toBe('Renvoyer (60s)');
    expect(resendButton().disabled).toBe(true);

    fireEvent.click(resendButton());
    expect(forgotPassword).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 60; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(resendButton().textContent).toBe('Renvoyer');
    expect(resendButton().disabled).toBe(false);
  });

  it('renvoi : efface une erreur de code précédente', async () => {
    resetPassword.mockRejectedValueOnce(new Error('Code invalide'));
    forgotPassword.mockResolvedValueOnce({});
    renderReset();
    pasteCode('123456');
    typePasswords(STRONG, STRONG);
    fireEvent.click(submitButton());
    await waitFor(() => expect(errorBanner()).toBe('⚠ Code invalide'));
    fireEvent.click(resendButton());
    expect(errorBanner()).toBeNull();
    await screen.findByText('Si un compte existe, un nouveau code a été envoyé.');
  });

  it('pendant le renvoi : bouton « Envoi... » désactivé', async () => {
    let resolve!: (v: unknown) => void;
    forgotPassword.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderReset();
    fireEvent.click(resendButton());
    expect(resendButton().textContent).toBe('Envoi...');
    expect(resendButton().disabled).toBe(true);
    await act(async () => resolve({}));
    expect(resendButton().textContent).toBe('Renvoyer (60s)');
  });

  it('échec du renvoi : erreur affichée, pas de cooldown', async () => {
    forgotPassword.mockRejectedValueOnce(new Error('Trop de demandes'));
    renderReset();
    fireEvent.click(resendButton());
    await waitFor(() => expect(errorBanner()).toBe('⚠ Trop de demandes'));
    expect(resendButton().textContent).toBe('Renvoyer');
  });

  it('échec du renvoi (rejet non-Error) : message générique', async () => {
    forgotPassword.mockRejectedValueOnce(0);
    renderReset();
    fireEvent.click(resendButton());
    await waitFor(() => expect(errorBanner()).toBe('⚠ Erreur de connexion au serveur'));
  });

  it('les boutons œil basculent chaque champ indépendamment', () => {
    renderReset();
    const [eyePw, eyeConfirm] = screen.getAllByRole('button', { name: 'Afficher' });
    fireEvent.click(eyePw);
    expect(passwordInputs()[0].type).toBe('text');
    expect(passwordInputs()[1].type).toBe('password');
    expect(eyePw.getAttribute('aria-label')).toBe('Masquer');
    fireEvent.click(eyeConfirm);
    expect(passwordInputs()[1].type).toBe('text');
  });

  it('lien « ← Retour à la connexion » : navigue vers /login', () => {
    renderReset();
    fireEvent.click(screen.getByText('← Retour à la connexion'));
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });

  it('le bouton de thème appelle toggleTheme', () => {
    const { container } = renderReset();
    fireEvent.click(container.querySelector('.light-dark-btn') as HTMLButtonElement);
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });
});
