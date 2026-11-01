import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import CourseChannelList from './CourseChannelList';

afterEach(cleanup);

const CHANNELS = [
  { id: 3, name: 'Discussion', type: 'text' },
  { id: 7, name: 'Quiz 1', type: 'quiz' },
  { id: 11, name: 'Annonces', type: 'announcement' },
];

describe('CourseChannelList — canal d’annonces', () => {
  it('affiche « Annonces » en tête, avant toutes les sections, et hors section', () => {
    const { container } = render(<CourseChannelList channels={CHANNELS} />);

    const buttons = within(container).getAllByRole('button');
    // Le 1er bouton de la liste est le canal d'annonces (avant les en-têtes de section).
    expect(buttons[0].textContent).toContain('Annonces');
    for (const section of container.querySelectorAll('section')) {
      expect(section.textContent).not.toContain('Annonces');
    }
  });

  it('se sélectionne et s’ouvre comme un canal', () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    render(<CourseChannelList channels={CHANNELS} onSelectChannel={onSelect} onOpenChannel={onOpen} />);

    fireEvent.click(screen.getByText('Annonces'));

    expect(onSelect).toHaveBeenCalledWith({ id: 11, type: 'announcement' });
    expect(onOpen).toHaveBeenCalledWith(CHANNELS[2]);
  });

  it('marque le canal d’annonces sélectionné', () => {
    render(<CourseChannelList channels={CHANNELS} selectedChannel={{ id: 11, type: 'announcement' }} />);

    expect(screen.getByText('Annonces').closest('button')?.getAttribute('aria-current')).toBe('page');
  });
});

describe('CourseChannelList — entrée Devoirs', () => {
  it('absente par défaut', () => {
    render(<CourseChannelList channels={CHANNELS} />);
    expect(screen.queryByText('Devoirs')).toBeNull();
  });

  it('épinglée après Annonces, hors sections, même sans canal d’annonces', () => {
    const { container, rerender } = render(<CourseChannelList channels={CHANNELS} assignments={{}} />);
    const buttons = within(container).getAllByRole('button');
    expect(buttons[0].textContent).toContain('Annonces');
    expect(buttons[1].textContent).toContain('Devoirs');

    rerender(<CourseChannelList channels={[]} assignments={{}} />);
    expect(within(container).getByRole('list', { name: 'Épinglés' }).textContent).toBe('Devoirs');
  });

  it('ouvre la liste des devoirs, et reste active sur un devoir ouvert', () => {
    const onSelect = vi.fn();
    render(
      <CourseChannelList
        assignments={{}}
        onSelectChannel={onSelect}
        selectedChannel={{ id: 1005, type: 'assignment' }}
      />
    );
    const entry = screen.getByText('Devoirs').closest('button')!;
    expect(entry.getAttribute('aria-current')).toBe('page');
    fireEvent.click(entry);
    expect(onSelect).toHaveBeenCalledWith({ id: 0, type: 'assignment' });
  });

  it('montre le nombre à remettre, et rien à zéro', () => {
    const { rerender } = render(<CourseChannelList assignments={{ count: 2 }} />);
    expect(screen.getByLabelText('2 à remettre').textContent).toBe('2');
    rerender(<CourseChannelList assignments={{ count: 0 }} />);
    expect(screen.queryByLabelText(/à remettre/)).toBeNull();
  });
});
