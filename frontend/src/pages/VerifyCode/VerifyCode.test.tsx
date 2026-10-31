import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigationType } from 'react-router-dom';

/**
 * Tests de la page de vérification par code (e-mail à l'inscription, ou 2FA à la connexion).
 * Les appels verifyEmail / verify2FA / resendCode sont mockés ; la navigation est vérifiée via
 * une sonde rendue sur la route cible ; le compte à rebours du renvoi utilise des faux timers.
 */

const verifyEmail = vi.fn();
const verify2FA = vi.fn();
const resendCode = vi.fn();
vi.mock('../../helpers/api', () => ({
  verifyEmail: (...a: unknown[]) => verifyEmail(...a),
  verify2FA: (...a: unknown[]) => verify2FA(...a),
  resendCode: (...a: unknown[]) => resendCode(...a),
}));

import VerifyCode from './VerifyCode';
import { ThemeContext } from '../../context/themeContext';

const toggleTheme = vi.fn();
const EMAIL = 'k@usherbrooke.ca';

function LocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="navigation">{navigationType}</span>
    </>
  );
}

function renderVerify(state: unknown = { email: EMAIL, mode: 'email' }) {
  return render(
    <ThemeContext.Provider value={{ theme: 'light', setTheme: vi.fn(), toggleTheme }}>
      <MemoryRouter initialEntries={[{ pathname: '/verify-code', state }]}>
        <Routes>
          <Route path="/verify-code" element={<VerifyCode />} />
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

/** Saisit un code chiffre par chiffre (comme au clavier). */
function typeCode(code: string) {
  code.split('').forEach((d, i) => fireEvent.change(boxes()[i], { target: { value: d } }));
}

function pasteCode(text: string) {
  fireEvent.paste(boxes()[0], { clipboardData: { getData: () => text } });
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Vérifi/ }) as HTMLButtonElement;
}

function resendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Renvoyer|Envoi/ }) as HTMLButtonElement;
}

beforeEach(() => {
  verifyEmail.mockReset();
  verify2FA.mockReset();
  resendCode.mockReset();
  toggleTheme.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('VerifyCode', () => {
  it('accès direct sans e-mail (state vide) : redirige vers /login', () => {
    renderVerify(null);
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });

  it('mode email : titre dédié, focus sur la 1re case, lien « Déjà un compte »', () => {
    renderVerify();
    expect(screen.getByText('Vérifiez votre email')).toBeTruthy();
    expect(document.activeElement).toBe(boxes()[0]);
    expect(screen.getByText('Déjà un compte ?', { exact: false })).toBeTruthy();
  });

  it('mode absent du state : mode email par défaut', () => {
    renderVerify({ email: EMAIL });
    expect(screen.getByText('Vérifiez votre email')).toBeTruthy();
  });

  it('mode 2fa : titre « Double authentification », pas de lien « Déjà un compte »', () => {
    renderVerify({ email: EMAIL, mode: '2fa' });
    expect(screen.getByText('Double authentification')).toBeTruthy();
    expect(screen.queryByText('Déjà un compte ?', { exact: false })).toBeNull();
  });

  it('mode email : le 6e chiffre déclenche verifyEmail puis remplace l’écran par /home', async () => {
    verifyEmail.mockResolvedValueOnce({});
    renderVerify();
    typeCode('12345');
    expect(verifyEmail).not.toHaveBeenCalled();
    typeCode('123456');
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(verifyEmail).toHaveBeenCalledWith(EMAIL, '123456');
    expect(verify2FA).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/home'));
    // #63 : l'écran de code est REMPLACÉ, le bouton « back » n'y ramène pas une fois connecté.
    expect(screen.getByTestId('navigation').textContent).toBe('REPLACE');
  });

  it('mode 2fa : le collage d’un code complet déclenche verify2FA', async () => {
    verify2FA.mockResolvedValueOnce({});
    renderVerify({ email: EMAIL, mode: '2fa' });
    pasteCode('654 321');
    expect(verify2FA).toHaveBeenCalledWith(EMAIL, '654321');
    expect(verifyEmail).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/home'));
  });

  it('soumission avec un code incomplet : erreur, aucun appel', () => {
    renderVerify();
    typeCode('123');
    fireEvent.click(submitButton());
    expect(screen.getByText('⚠ Le code doit contenir 6 chiffres')).toBeTruthy();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it('pendant la vérification : cases et bouton désactivés, « Vérification... »', async () => {
    let resolve!: (v: unknown) => void;
    verifyEmail.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderVerify();
    pasteCode('123456');
    expect(submitButton().textContent).toBe('Vérification...');
    expect(submitButton().disabled).toBe(true);
    expect(boxes().every((b) => b.disabled)).toBe(true);
    await act(async () => resolve({}));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/home'));
  });

  it('code refusé : message serveur affiché, cases en erreur, on reste sur la page', async () => {
    verifyEmail.mockRejectedValueOnce(new Error('Code expiré'));
    renderVerify();
    const classBefore = boxes()[0].className;
    pasteCode('123456');
    await screen.findByText('⚠ Code expiré');
    expect(boxes()[0].className).not.toBe(classBefore);
    expect(boxes()[0].disabled).toBe(false);
    expect(screen.queryByTestId('path')).toBeNull();
  });

  it('rejet non-Error : « Erreur de connexion au serveur »', async () => {
    verifyEmail.mockRejectedValueOnce(undefined);
    renderVerify();
    pasteCode('123456');
    await screen.findByText('⚠ Erreur de connexion au serveur');
  });

  it('bouton Vérifier après correction : resoumet le code courant', async () => {
    verifyEmail.mockRejectedValueOnce(new Error('Code invalide')).mockResolvedValueOnce({});
    renderVerify();
    pasteCode('123456');
    await screen.findByText('⚠ Code invalide');
    fireEvent.click(submitButton());
    expect(verifyEmail).toHaveBeenCalledTimes(2);
    expect(verifyEmail).toHaveBeenLastCalledWith(EMAIL, '123456');
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/home'));
  });

  it('renvoi du code : appelle resendCode(email, mode), confirme et lance un cooldown de 60 s', async () => {
    vi.useFakeTimers();
    resendCode.mockResolvedValueOnce({ message: 'ok' });
    renderVerify({ email: EMAIL, mode: '2fa' });
    await act(async () => {
      fireEvent.click(resendButton());
    });
    expect(resendCode).toHaveBeenCalledWith(EMAIL, '2fa');
    expect(screen.getByText('Un nouveau code a été envoyé.')).toBeTruthy();
    expect(resendButton().textContent).toBe('Renvoyer (60s)');
    expect(resendButton().disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(resendButton().textContent).toBe('Renvoyer (59s)');

    // Un clic pendant le cooldown est ignoré.
    fireEvent.click(resendButton());
    expect(resendCode).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 59; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(resendButton().textContent).toBe('Renvoyer le code');
    expect(resendButton().disabled).toBe(false);
  });

  it('pendant le renvoi : bouton « Envoi... » désactivé', async () => {
    let resolve!: (v: unknown) => void;
    resendCode.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderVerify();
    fireEvent.click(resendButton());
    expect(resendButton().textContent).toBe('Envoi...');
    expect(resendButton().disabled).toBe(true);
    await act(async () => resolve({}));
    expect(resendButton().textContent).toBe('Renvoyer (60s)');
  });

  it('échec du renvoi : erreur affichée, pas de cooldown', async () => {
    resendCode.mockRejectedValueOnce(new Error('Trop de demandes'));
    renderVerify();
    fireEvent.click(resendButton());
    await screen.findByText('⚠ Trop de demandes');
    expect(resendButton().textContent).toBe('Renvoyer le code');
    expect(resendButton().disabled).toBe(false);
  });

  it('échec du renvoi (rejet non-Error) : message générique', async () => {
    resendCode.mockRejectedValueOnce('x');
    renderVerify();
    fireEvent.click(resendButton());
    await screen.findByText('⚠ Erreur de connexion au serveur');
  });

  it('mode email : « ← Retour » mène à /register', () => {
    renderVerify();
    fireEvent.click(screen.getByText('← Retour'));
    expect(screen.getByTestId('path').textContent).toBe('/register');
  });

  it('mode 2fa : « ← Retour » mène à /login', () => {
    renderVerify({ email: EMAIL, mode: '2fa' });
    fireEvent.click(screen.getByText('← Retour'));
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });

  it('mode email : « Se connecter » mène à /login', () => {
    renderVerify();
    fireEvent.click(screen.getByText('Se connecter'));
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });

  it('le bouton de thème appelle toggleTheme', () => {
    renderVerify();
    fireEvent.click(screen.getByRole('button', { name: 'Changer de thème' }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });
});
