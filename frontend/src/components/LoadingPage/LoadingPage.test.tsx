import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import LoadingPage from './LoadingPage';

afterEach(cleanup);

describe('LoadingPage', () => {
  it('expose un statut occupé accessible avec le texte « Chargement… »', () => {
    render(<LoadingPage />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Chargement…');
  });
});
