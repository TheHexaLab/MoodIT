import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import LeftMenuGroup from './LeftMenuGroup';

// css: true applique les CSS modules : la barre mobile est masquée (display:none) en jsdom,
// d'où l'option « hidden: true » sur les requêtes par rôle qui la ciblent.
afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function renderGroup(props: Partial<React.ComponentProps<typeof LeftMenuGroup>> = {}) {
  return render(
    <LeftMenuGroup
      programMenu={<div>Menu programmes</div>}
      courseMenu={<div>Menu cours</div>}
      {...props}
    />
  );
}

/** Bouton hamburger (seul porteur d'aria-controls). */
function hamburger(): HTMLElement {
  const el = document.querySelector('[aria-controls="left-menu-drawer"]');
  if (!el) throw new Error('hamburger introuvable');
  return el as HTMLElement;
}

describe('LeftMenuGroup', () => {
  it('rend les deux menus dans le tiroir et le titre par défaut « Accueil »', () => {
    renderGroup();
    const drawer = screen.getByRole('complementary', { name: 'Menus lateraux' });
    expect(drawer.textContent).toContain('Menu programmes');
    expect(drawer.textContent).toContain('Menu cours');
    expect(screen.getByRole('title', { hidden: true }).textContent).toBe('Accueil');
    expect(screen.queryByRole('prefix', { hidden: true })).toBeNull();
  });

  it('affiche le titre et le préfixe fournis', () => {
    renderGroup({ mobileTitle: 'general', mobileTitlePrefix: <span>#</span> });
    expect(screen.getByRole('title', { hidden: true }).textContent).toBe('general');
    expect(screen.getByRole('prefix', { hidden: true }).textContent).toBe('#');
  });

  it("sans menu du compte : avatar de repli avec l'initiale fournie", () => {
    renderGroup({ mobileUserInitial: 'Z' });
    expect(screen.getByLabelText('Utilisateur connecté').textContent).toBe('Z');
  });

  it("avec menu du compte : il remplace l'avatar de repli", () => {
    renderGroup({ mobileUserMenu: <button type="button">Compte</button> });
    expect(screen.getByRole('button', { name: 'Compte', hidden: true })).toBeTruthy();
    expect(screen.queryByLabelText('Utilisateur connecté')).toBeNull();
  });

  it('le hamburger ouvre le tiroir et bloque le défilement du body', () => {
    renderGroup();
    const button = hamburger();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Ouvrir le menu');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Fermer le menu');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('Échap referme le tiroir et restaure le défilement précédent', () => {
    document.body.style.overflow = 'auto';
    renderGroup();
    fireEvent.click(hamburger());
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(hamburger().getAttribute('aria-expanded')).toBe('false');
    expect(document.body.style.overflow).toBe('auto');
  });

  it("une autre touche qu'Échap laisse le tiroir ouvert", () => {
    renderGroup();
    fireEvent.click(hamburger());
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(hamburger().getAttribute('aria-expanded')).toBe('true');
  });

  it('un clic sur le voile referme le tiroir', () => {
    renderGroup();
    fireEvent.click(hamburger());
    // Le voile est le bouton « Fermer le menu » qui n'est PAS le hamburger.
    const backdrop = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[aria-label="Fermer le menu"]')
    ).find((el) => !el.hasAttribute('aria-controls'));
    if (!backdrop) throw new Error('voile introuvable');
    fireEvent.click(backdrop);
    expect(hamburger().getAttribute('aria-expanded')).toBe('false');
  });
});
