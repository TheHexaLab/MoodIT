import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SchedulePage from './SchedulePage';
import type { ScheduleCourse, ScheduleSession } from '../../types/domain';

afterEach(cleanup);

/** Mercredi 28 octobre 2026 : la semaine du 26 au 30 octobre. */
const NOW = new Date(2026, 9, 28, 12, 0);
const COURSES: ScheduleCourse[] = [
  { id: 10, code: 'INF201', programId: 1 },
  { id: 11, code: 'MAT265', programId: 2 },
];

const at = (week: Date, day: number, hour: number, minute = 0) => {
  const date = new Date(week);
  date.setDate(date.getDate() + day);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

/** Deux séances par semaine, aux mêmes jours que la semaine demandée. */
const weekly = vi.fn(async (weekStart: Date): Promise<ScheduleSession[]> => [
  { id: 1, courseId: 10, kind: 'Cours', room: 'C1-3125', start: at(weekStart, 0, 8, 30), end: at(weekStart, 0, 10, 15) },
  { id: 2, courseId: 11, kind: 'Laboratoire', room: 'D7-2021', start: at(weekStart, 2, 13, 30), end: at(weekStart, 2, 15, 15) },
]);

function setup(props: Partial<React.ComponentProps<typeof SchedulePage>> = {}) {
  const onOpenCourse = vi.fn();
  render(
    <SchedulePage
      courses={COURSES}
      onFetchSchedule={weekly}
      onOpenCourse={onOpenCourse}
      now={NOW}
      {...props}
    />
  );
  return { onOpenCourse };
}

describe('SchedulePage — grille', () => {
  it('annonce le chargement, puis montre la semaine et le jour courant', async () => {
    setup();
    expect(screen.getByRole('status').textContent).toContain('Chargement');
    expect(await screen.findByRole('group', { name: 'Semaine du 26 au 30 octobre 2026' })).toBeTruthy();
    expect(screen.getByText('Mer 28').getAttribute('aria-current')).toBe('date');
    expect(screen.getByText('Lun 26').getAttribute('aria-current')).toBeNull();
  });

  it('montre chaque séance avec son cours, son type, son local et ses heures', async () => {
    setup();
    const block = await screen.findByRole('button', { name: /^INF201/ });
    expect(block.textContent).toContain('Cours · C1-3125');
    expect(block.textContent).toContain('8 h 30 à 10 h 15');
    // Le nom accessible reprend le texte visible, puis le jour.
    expect(block.textContent).toContain('lundi 26 octobre');
    expect(block.style.top).toBe(`${0.5 * 4.375}rem`);
  });

  it('un clic sur une séance ouvre son cours, dans son programme', async () => {
    const { onOpenCourse } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /^MAT265/ }));
    expect(onOpenCourse).toHaveBeenCalledWith(2, 11);
  });

  it('passe d’une semaine à l’autre, et « Aujourd’hui » revient à la semaine en cours', async () => {
    setup();
    await screen.findByRole('button', { name: /^INF201/ });
    const today = screen.getByRole('button', { name: "Aujourd'hui" }) as HTMLButtonElement;
    expect(today.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
    expect(screen.getByText('Semaine du 2 au 6 novembre 2026')).toBeTruthy();
    await screen.findByRole('button', { name: /^INF201/ });
    expect(screen.queryByText((_, element) => element?.getAttribute('aria-current') === 'date')).toBeNull();
    expect(today.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    expect(screen.getByText('Semaine du 19 au 23 octobre 2026')).toBeTruthy();

    fireEvent.click(today);
    expect(screen.getByText('Semaine du 26 au 30 octobre 2026')).toBeTruthy();
    await screen.findByRole('button', { name: /^INF201/ });
  });

  it('ignore une séance d’un cours inconnu', async () => {
    setup({ onFetchSchedule: vi.fn().mockResolvedValue([{ id: 9, courseId: 99, kind: 'Cours', room: 'X', start: at(new Date(2026, 9, 26), 0, 9), end: at(new Date(2026, 9, 26), 0, 10) }]) });
    await screen.findByRole('group');
    expect(screen.queryByRole('button', { name: /Cours/ })).toBeNull();
  });

  it('une semaine sans séance le dit, sans cacher la grille', async () => {
    setup({ onFetchSchedule: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText('Aucun cours cette semaine.')).toBeTruthy();
    expect(screen.getByRole('group')).toBeTruthy();
  });

  it('sans cours, invite à en rejoindre un', async () => {
    setup({ courses: [], onFetchSchedule: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText('Rejoignez un cours pour voir votre horaire.')).toBeTruthy();
  });

  it('un échec de chargement propose de réessayer', async () => {
    const onFetchSchedule = vi.fn().mockRejectedValueOnce(new Error('panne')).mockImplementation(weekly);
    setup({ onFetchSchedule });
    fireEvent.click(await screen.findByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('button', { name: /^INF201/ })).toBeTruthy();
    expect(onFetchSchedule).toHaveBeenCalledTimes(2);
  });

  it('ne recharge pas pour un nouveau tableau aux mêmes cours', async () => {
    const onFetchSchedule = vi.fn(weekly);
    const { rerender } = render(
      <SchedulePage courses={COURSES} onFetchSchedule={onFetchSchedule} onOpenCourse={vi.fn()} now={NOW} />
    );
    await screen.findByRole('button', { name: /^INF201/ });
    rerender(
      <SchedulePage courses={[...COURSES]} onFetchSchedule={onFetchSchedule} onOpenCourse={vi.fn()} now={NOW} />
    );
    await waitFor(() => expect(onFetchSchedule).toHaveBeenCalledTimes(1));
  });
});

describe('SchedulePage — mobile', () => {
  it('une liste par jour, sans les jours vides, avec le jour courant marqué', async () => {
    setup({ compact: true });
    const monday = await screen.findByRole('region', { name: 'lundi 26 octobre' });
    expect(within(monday).getByRole('heading', { name: 'Lundi 26 octobre' })).toBeTruthy();
    expect(within(monday).getByRole('button', { name: /^INF201/ })).toBeTruthy();

    const wednesday = screen.getByRole('region', { name: 'mercredi 28 octobre' });
    expect(within(wednesday).getByText("Aujourd'hui")).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'mardi 27 octobre' })).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('une semaine sans séance le dit', async () => {
    setup({ compact: true, onFetchSchedule: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText('Aucun cours cette semaine.')).toBeTruthy();
  });
});
