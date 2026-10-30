import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import UserMenu, { type UserMenuUser } from './UserMenu';
import { ThemeContext, type Theme, type ThemeApi } from '../../context/themeContext';
import { CurrentUserContext, type CurrentUserApi } from '../../context/currentUserContext';

// matchMedia piloté : `mobile` → (max-width: 900px) ; `reduce` → prefers-reduced-motion.
// Les écouteurs « change » sont capturés pour simuler un passage desktop ↔ mobile.
let mediaListeners: ((e: MediaQueryListEvent) => void)[] = [];
function stubMatchMedia({ mobile = false, reduce = true } = {}) {
  mediaListeners = [];
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('max-width') ? mobile : query.includes('reduce') ? reduce : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
        mediaListeners.push(cb);
      },
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

const user: UserMenuUser = {
  id: 1,
  username: 'jdoe',
  firstName: 'Jean',
  lastName: 'Doe',
  avatarColor: '#123456',
};

interface Setup {
  user?: UserMenuUser | null;
  props?: Partial<React.ComponentProps<typeof UserMenu>>;
  theme?: Theme;
}

function renderMenu({ user: u = user, props = {}, theme = 'light' }: Setup = {}) {
  const setTheme = vi.fn();
  const saveSettings = vi.fn();
  const themeValue: ThemeApi = { theme, setTheme, toggleTheme: vi.fn() };
  const userValue = { saveSettings } as unknown as CurrentUserApi;
  const utils = render(
    <ThemeContext.Provider value={themeValue}>
      <CurrentUserContext.Provider value={userValue}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<UserMenu user={u} {...props} />} />
            <Route path="/login" element={<p>Page de connexion</p>} />
          </Routes>
        </MemoryRouter>
      </CurrentUserContext.Provider>
    </ThemeContext.Provider>
  );
  return { setTheme, saveSettings, ...utils };
}

/** jsdom n'a pas AnimationEvent : React écoute alors `webkitAnimationEnd` (cf. DeleteConfirmationPopup.test). */
function fireAnimationEnd(el: HTMLElement) {
  fireEvent(el, new Event('webkitAnimationEnd', { bubbles: true }));
}

function trigger() {
  return screen.getByRole('button', { name: /^Compte utilisateur/ });
}

function openMenu() {
  fireEvent.click(trigger());
  return screen.getByRole('menu', { name: 'Menu du compte' });
}

beforeEach(() => {
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('UserMenu', () => {
  describe('déclencheur', () => {
    it('footer : nom complet, @handle et initiales', () => {
      renderMenu();
      const btn = trigger();
      expect(btn.textContent).toContain('Jean Doe');
      expect(btn.textContent).toContain('@jdoe');
      // Initiales dessinées en CSS : attribut, pas texte (hors du texte visible).
      expect(btn.querySelector('[data-initials]')?.getAttribute('data-initials')).toBe('JD');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
    });

    it('footer : le nom accessible contient le texte visible (WCAG 2.5.3)', () => {
      renderMenu();
      expect(screen.getByRole('button', { name: 'Compte utilisateur : Jean Doe @jdoe' })).toBeTruthy();
    });

    it('sans prénom/nom : affiche le nom d’utilisateur et une seule initiale', () => {
      renderMenu({ user: { id: 2, username: 'alice', firstName: '', lastName: '' } });
      expect(trigger().textContent).toBe('alice @alice');
      expect(trigger().querySelector('[data-initials]')?.getAttribute('data-initials')).toBe('A');
    });

    it('sans utilisateur : libellés de repli', () => {
      renderMenu({ user: null });
      expect(trigger().textContent).toBe('Utilisateur @utilisateur');
    });

    it('compact : pastille d’initiales seule', () => {
      renderMenu({ props: { variant: 'compact' } });
      expect(trigger().getAttribute('data-initials')).toBe('JD');
      expect(trigger().textContent).toBe('');
    });

    it('chargement : skeleton, pas de déclencheur', () => {
      const { container } = renderMenu({ props: { loading: true } });
      expect(screen.queryByRole('button', { name: /^Compte utilisateur/ })).toBeNull();
      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });

    it('chargement en variante compacte : pas de déclencheur non plus', () => {
      renderMenu({ props: { loading: true, variant: 'compact' } });
      expect(screen.queryByRole('button', { name: /^Compte utilisateur/ })).toBeNull();
    });
  });

  describe('popup', () => {
    it('s’ouvre au clic avec la carte d’identité et les actions de base', () => {
      renderMenu();
      const menu = openMenu();
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      expect(menu.textContent).toContain('Jean Doe');
      expect(menu.textContent).toContain('@jdoe');
      expect(screen.getByRole('menuitem', { name: 'Modifier le profil' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: "Copier le nom d'utilisateur" })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'Se déconnecter' })).toBeTruthy();
      // Entrées réservées masquées sans callback.
      expect(screen.queryByRole('menuitem', { name: 'Gérer les administrateurs' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Journalisation' })).toBeNull();
    });

    it('un second clic sur le déclencheur referme le popup', () => {
      renderMenu();
      openMenu();
      fireEvent.click(trigger());
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('Échap et clic extérieur referment le popup', () => {
      renderMenu();
      openMenu();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      openMenu();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('un mousedown dans le popup ne le ferme pas', () => {
      renderMenu();
      const menu = openMenu();
      fireEvent.mouseDown(menu);
      expect(screen.queryByRole('menu')).not.toBeNull();
    });

    it('sans animations réduites : la fermeture attend la fin de l’animation', () => {
      stubMatchMedia({ reduce: false });
      renderMenu();
      const menu = openMenu();
      fireEvent.keyDown(document, { key: 'Escape' });
      // Toujours monté pendant l'animation de sortie…
      expect(screen.queryByRole('menu')).not.toBeNull();
      fireAnimationEnd(menu);
      // …puis démonté.
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('re-cliquer pendant l’animation de sortie annule la fermeture', () => {
      stubMatchMedia({ reduce: false });
      renderMenu();
      const menu = openMenu();
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(trigger());
      fireAnimationEnd(menu);
      expect(screen.queryByRole('menu')).not.toBeNull();
    });

    it('« Modifier le profil » ferme le popup et appelle onEditProfile', () => {
      const onEditProfile = vi.fn();
      renderMenu({ props: { onEditProfile } });
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Modifier le profil' }));
      expect(onEditProfile).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('« Gérer les administrateurs » et « Journalisation » apparaissent avec leur callback', () => {
      const onManageAdmins = vi.fn();
      const onViewAuditLogs = vi.fn();
      renderMenu({ props: { onManageAdmins, onViewAuditLogs } });
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Gérer les administrateurs' }));
      expect(onManageAdmins).toHaveBeenCalledTimes(1);
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Journalisation' }));
      expect(onViewAuditLogs).toHaveBeenCalledTimes(1);
    });
  });

  describe('thème', () => {
    it('clair → bascule en sombre et persiste dans les settings', () => {
      const { setTheme, saveSettings } = renderMenu({ theme: 'light' });
      openMenu();
      const toggle = screen.getByRole('menuitemcheckbox', { name: 'Mode sombre' });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      fireEvent.click(toggle);
      expect(setTheme).toHaveBeenCalledWith('dark');
      expect(saveSettings).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('sombre → bascule en clair', () => {
      const { setTheme, saveSettings } = renderMenu({ theme: 'dark' });
      openMenu();
      const toggle = screen.getByRole('menuitemcheckbox', { name: 'Mode sombre' });
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      fireEvent.click(toggle);
      expect(setTheme).toHaveBeenCalledWith('light');
      expect(saveSettings).toHaveBeenCalledWith({ theme: 'light' });
    });
  });

  describe('copie du nom d’utilisateur', () => {
    it('écrit le nom dans le presse-papiers puis affiche « Nom copié » pendant 1,5 s', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      renderMenu();
      openMenu();
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: "Copier le nom d'utilisateur" }));
      });
      expect(writeText).toHaveBeenCalledWith('jdoe');
      expect(screen.getByRole('menuitem', { name: 'Nom copié' })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByRole('menuitem', { name: "Copier le nom d'utilisateur" })).toBeTruthy();
    });

    it('presse-papiers indisponible : échec silencieux, libellé inchangé', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('refus'));
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      renderMenu();
      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: "Copier le nom d'utilisateur" }));
      });
      expect(writeText).toHaveBeenCalled();
      expect(screen.queryByRole('menuitem', { name: 'Nom copié' })).toBeNull();
    });

    it('sans nom d’utilisateur : rien n’est copié', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      renderMenu({ user: { id: 3, username: '', firstName: 'X', lastName: '' } });
      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: "Copier le nom d'utilisateur" }));
      });
      expect(writeText).not.toHaveBeenCalled();
    });
  });

  describe('déconnexion', () => {
    it('POST /auth/logout, appelle onLogout et redirige vers /login', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
      const onLogout = vi.fn();
      renderMenu({ props: { onLogout } });
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Se déconnecter' }));
      await waitFor(() => expect(screen.getByText('Page de connexion')).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledWith('/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      expect(onLogout).toHaveBeenCalledTimes(1);
    });

    it('même si le serveur est injoignable : onLogout + redirection', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('réseau')));
      const onLogout = vi.fn();
      // Le rejet remonte après le finally : on l'absorbe pour ne pas polluer le test.
      const onUnhandled = (e: PromiseRejectionEvent) => e.preventDefault();
      window.addEventListener('unhandledrejection', onUnhandled);
      const swallow = () => {};
      // Process Node du lanceur de tests (les types de Node ne sont pas chargés côté application).
      const nodeProcess = (globalThis as unknown as {
        process: { on(event: string, fn: () => void): void; off(event: string, fn: () => void): void };
      }).process;
      nodeProcess.on('unhandledRejection', swallow);
      try {
        renderMenu({ props: { onLogout } });
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Se déconnecter' }));
        await waitFor(() => expect(screen.getByText('Page de connexion')).toBeTruthy());
        expect(onLogout).toHaveBeenCalledTimes(1);
      } finally {
        await new Promise((r) => setTimeout(r, 0));
        nodeProcess.off('unhandledRejection', swallow);
        window.removeEventListener('unhandledrejection', onUnhandled);
      }
    });
  });

  describe('mobile (feuille basse)', () => {
    it('ouvre une feuille avec un voile qui la referme au clic', () => {
      stubMatchMedia({ mobile: true });
      renderMenu();
      openMenu();
      const scrim = screen.getByRole('button', { name: 'Fermer le menu du compte' });
      // En mobile, la position est gérée par le CSS : pas de style inline.
      expect(screen.getByRole('menu').getAttribute('style')).toBeNull();
      fireEvent.click(scrim);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('desktop : pas de voile, position calculée en style inline', () => {
      renderMenu();
      const menu = openMenu();
      expect(screen.queryByRole('button', { name: 'Fermer le menu du compte' })).toBeNull();
      expect(menu.style.left).not.toBe('');
    });

    it('bascule en mode feuille quand la media query change', () => {
      renderMenu();
      openMenu();
      expect(screen.queryByRole('button', { name: 'Fermer le menu du compte' })).toBeNull();
      act(() => {
        mediaListeners.forEach((cb) => cb({ matches: true } as MediaQueryListEvent));
      });
      expect(screen.getByRole('button', { name: 'Fermer le menu du compte' })).toBeTruthy();
    });
  });
});
