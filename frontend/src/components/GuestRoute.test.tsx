import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigationType } from 'react-router-dom';
import GuestRoute from './GuestRoute';
import { hasActiveSession } from '../helpers/api';

vi.mock('../helpers/api', () => ({ hasActiveSession: vi.fn() }));

beforeEach(() => {
  vi.mocked(hasActiveSession).mockReset();
});
afterEach(cleanup);

function Home() {
  return <p>Accueil ({useNavigationType()})</p>;
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route
          path="/login"
          element={
            <GuestRoute>
              <p>Page de connexion</p>
            </GuestRoute>
          }
        />
        <Route path="/home" element={<Home />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('GuestRoute (#63)', () => {
  it('vérification en cours : page de chargement, sans le formulaire', () => {
    vi.mocked(hasActiveSession).mockReturnValue(new Promise(() => {}));
    renderLogin();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('Page de connexion')).toBeNull();
  });

  it('déjà connecté : /home, en remplaçant l’entrée d’historique', async () => {
    vi.mocked(hasActiveSession).mockResolvedValue(true);
    renderLogin();
    await screen.findByText('Accueil (REPLACE)');
    expect(screen.queryByText('Page de connexion')).toBeNull();
  });

  it('pas de session : la page demandée', async () => {
    vi.mocked(hasActiveSession).mockResolvedValue(false);
    renderLogin();
    await screen.findByText('Page de connexion');
  });

  it('démonté avant la réponse : aucune mise à jour', async () => {
    let resolve!: (active: boolean) => void;
    vi.mocked(hasActiveSession).mockReturnValue(new Promise((r) => (resolve = r)));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderLogin();
    unmount();
    resolve(true);
    await waitFor(() => expect(hasActiveSession).toHaveBeenCalledTimes(1));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
