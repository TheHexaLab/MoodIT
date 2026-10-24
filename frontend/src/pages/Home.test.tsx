import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Home from './Home';

/**
 * Tests de la page d'accueil minimale (Home.tsx) : message de bienvenue et
 * déconnexion (purge du token local + redirection vers /login).
 */

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route path="/home" element={<Home />} />
        <Route path="/login" element={<p>Page de connexion</p>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Home', () => {
  beforeEach(() => localStorage.clear());

  it('affiche le message de bienvenue et le bouton de déconnexion', () => {
    renderHome();
    expect(screen.getByRole('heading', { name: /Connecté/ })).toBeTruthy();
    expect(screen.getByText('Bienvenue sur ton espace MoodIT.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeTruthy();
  });

  it('la déconnexion supprime le token local et redirige vers /login', () => {
    localStorage.setItem('moodit_token', 'tok');
    localStorage.setItem('autre', 'garde');
    renderHome();

    fireEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }));

    expect(localStorage.getItem('moodit_token')).toBeNull();
    expect(localStorage.getItem('autre')).toBe('garde');
    expect(screen.getByText('Page de connexion')).toBeTruthy();
  });
});
