import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ThemeProvider from './ThemeProvider';
import { useTheme } from './themeContext';

const STORAGE_KEY = 'moodit-theme';

// Petit consommateur du contexte : affiche le thème et expose les actions via boutons.
function Consumer() {
  const { theme, toggleTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={toggleTheme}>
        toggle
      </button>
      <button type="button" onClick={() => setTheme('dark')}>
        set-dark
      </button>
      <button type="button" onClick={() => setTheme('light')}>
        set-light
      </button>
    </div>
  );
}

// Pilote matchMedia (jsdom ne le fournit pas par défaut) pour contrôler la préférence OS.
function stubMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('dark') ? prefersDark : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ThemeProvider', () => {
  it('seed depuis localStorage quand une valeur valide est présente', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('sans cache local, utilise la préférence OS sombre', () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('sans cache local ni préférence OS sombre, défaut = light', () => {
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('ignore une valeur localStorage invalide et retombe sur la préférence OS', () => {
    localStorage.setItem(STORAGE_KEY, 'bogus');
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('applique data-theme sur <html> et mémorise dans localStorage au montage', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('toggleTheme bascule light -> dark et met à jour DOM + localStorage', () => {
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');

    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('toggleTheme bascule dark -> light', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('setTheme force un thème précis', () => {
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByText('set-dark'));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    fireEvent.click(screen.getByText('set-light'));
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('useTheme hors provider lève une erreur explicite', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/ThemeProvider/);
    spy.mockRestore();
  });
});
