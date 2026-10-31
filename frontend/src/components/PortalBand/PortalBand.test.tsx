import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PortalBand from './PortalBand';
import { currentSessionLabel } from './currentSession';

afterEach(cleanup);

describe('PortalBand', () => {
  it('affiche l’établissement, avec un lien vers l’Accueil', () => {
    render(
      <MemoryRouter>
        <PortalBand establishmentName="Université Test" />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: "Université Test, retour à l'Accueil" });
    expect(link.getAttribute('href')).toBe('/home');
  });

  it('sans établissement : « MoodIT »', () => {
    render(
      <MemoryRouter>
        <PortalBand />
      </MemoryRouter>
    );
    expect(screen.getByText('MoodIT')).toBeTruthy();
  });
});

describe('currentSessionLabel', () => {
  it.each([
    [new Date(2027, 0, 15), "Session d'hiver 2027"],
    [new Date(2027, 3, 30), "Session d'hiver 2027"],
    [new Date(2027, 4, 1), "Session d'été 2027"],
    [new Date(2027, 7, 31), "Session d'été 2027"],
    [new Date(2026, 8, 1), "Session d'automne 2026"],
  ])('%s', (date, label) => {
    expect(currentSessionLabel(date)).toBe(label);
  });
});
