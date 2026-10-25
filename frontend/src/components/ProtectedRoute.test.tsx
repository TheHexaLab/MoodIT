import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';
import {
  CurrentUserContext,
  type AuthStatus,
  type CurrentUserApi,
} from '../context/currentUserContext';

afterEach(cleanup);

/** Contexte minimal : seul `status` est lu par le garde. */
function renderWithStatus(status: AuthStatus) {
  const value = { status } as CurrentUserApi;
  return render(
    <CurrentUserContext.Provider value={value}>
      <MemoryRouter initialEntries={['/app']}>
        <Routes>
          <Route
            path="/app"
            element={
              <ProtectedRoute>
                <p>Page protégée</p>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<p>Page de connexion</p>} />
        </Routes>
      </MemoryRouter>
    </CurrentUserContext.Provider>
  );
}

describe('ProtectedRoute', () => {
  it('checking : affiche la page de chargement, sans les enfants', () => {
    renderWithStatus('checking');
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('Page protégée')).toBeNull();
    expect(screen.queryByText('Page de connexion')).toBeNull();
  });

  it('authed : rend les enfants', () => {
    renderWithStatus('authed');
    expect(screen.getByText('Page protégée')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('unauthed : redirige vers /login', () => {
    renderWithStatus('unauthed');
    expect(screen.getByText('Page de connexion')).toBeTruthy();
    expect(screen.queryByText('Page protégée')).toBeNull();
  });
});
