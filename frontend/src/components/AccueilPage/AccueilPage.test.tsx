import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AccueilPage from './AccueilPage';

afterEach(cleanup);

describe('AccueilPage', () => {
  it('salue l’utilisateur et affiche la date avec une majuscule', () => {
    render(<AccueilPage firstName="Camille" now={new Date(2026, 9, 30)} />);
    expect(screen.getByRole('heading', { name: 'Bonjour Camille' })).toBeTruthy();
    expect(screen.getByText('Vendredi 30 octobre')).toBeTruthy();
  });

  it('sans prénom : « Bonjour » seul', () => {
    render(<AccueilPage />);
    expect(screen.getByRole('heading', { name: 'Bonjour' })).toBeTruthy();
  });

  it('un filtre devient actif et change le message du fil vide', () => {
    render(<AccueilPage />);
    const devoirs = screen.getByRole('button', { name: 'Devoirs' });
    fireEvent.click(devoirs);
    expect(devoirs.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Aucun devoir pour le moment.')).toBeTruthy();
  });
});
