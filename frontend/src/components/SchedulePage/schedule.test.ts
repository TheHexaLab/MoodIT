import { describe, expect, it } from 'vitest';
import {
  COLOR_KEYS,
  TIME_OPTIONS,
  courseColor,
  dayIndex,
  dayTitle,
  draftError,
  draftToSession,
  draftToTask,
  emptyDraft,
  formatTime,
  isSameDay,
  minutesFromStart,
  placeItems,
  shiftTimes,
  shortDay,
  startOfWeek,
  taskDraft,
  toIso,
  weekDays,
  weekLabel,
} from './schedule';

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, 26 + day, hour, minute).toISOString();

function item(id: number, start: [number, number], end: [number, number]) {
  return { id, start: at(0, ...start), end: at(0, ...end) };
}

describe('semaine', () => {
  it('ramène n’importe quel jour à son lundi, fin de semaine comprise', () => {
    const monday = new Date(2026, 9, 26);
    for (const day of [26, 28, 30, 31, 1]) {
      const date = new Date(2026, day === 1 ? 10 : 9, day, 15, 0);
      expect(startOfWeek(date).getTime()).toBe(monday.getTime());
    }
  });

  it('donne les cinq jours de cours et leurs étiquettes', () => {
    const days = weekDays(new Date(2026, 9, 26));
    expect(days.map((day, index) => shortDay(day, index))).toEqual([
      'Lun 26',
      'Mar 27',
      'Mer 28',
      'Jeu 29',
      'Ven 30',
    ]);
    expect(dayTitle(days[0])).toBe('Lundi 26 octobre');
  });

  it('écrit la semaine, dans un mois, d’un mois à l’autre et d’une année à l’autre', () => {
    expect(weekLabel(new Date(2026, 9, 26))).toBe('Semaine du 26 au 30 octobre 2026');
    expect(weekLabel(new Date(2026, 10, 30))).toBe('Semaine du 30 novembre au 4 décembre 2026');
    expect(weekLabel(new Date(2026, 11, 28))).toBe('Semaine du 28 décembre 2026 au 1 janvier 2027');
  });

  it('compare des jours, pas des heures', () => {
    expect(isSameDay(new Date(2026, 9, 26, 8), new Date(2026, 9, 26, 23))).toBe(true);
    expect(isSameDay(new Date(2026, 9, 26), new Date(2026, 9, 27))).toBe(false);
  });
});

describe('événements', () => {
  it('écrit l’heure, la position dans la grille et le jour', () => {
    expect(formatTime(at(0, 8, 5))).toBe('8 h 05');
    expect(minutesFromStart(at(0, 10, 30))).toBe(630);
    expect(dayIndex(at(0, 9))).toBe(0);
    expect(dayIndex(at(4, 9))).toBe(4);
    expect(dayIndex(at(5, 9))).toBe(-1);
    expect(dayIndex(at(6, 9))).toBe(-1);
  });

  it('un événement seul n’est pas décalé et reste entier', () => {
    expect(placeItems([item(1, [8, 30], [10, 0])])).toEqual([
      expect.objectContaining({ depth: 0, visible: 90 }),
    ]);
  });

  it('ceux qui se chevauchent se décalent en cascade ; le suivant repart à gauche', () => {
    const placed = placeItems([
      item(3, [13, 0], [14, 0]),
      item(2, [9, 0], [11, 0]),
      item(4, [9, 30], [10, 0]),
      item(1, [8, 30], [10, 0]),
    ]);
    const byId = Object.fromEntries(placed.map((p) => [p.item.id, p]));
    expect(byId[1]).toMatchObject({ depth: 0, visible: 30 });
    expect(byId[2]).toMatchObject({ depth: 1, visible: 30 });
    expect(byId[4]).toMatchObject({ depth: 2, visible: 30 });
    expect(byId[3]).toMatchObject({ depth: 0, visible: 60 });
  });

  it('à début égal, le plus long passe dessous', () => {
    const placed = placeItems([item(1, [9, 0], [10, 0]), item(2, [9, 0], [12, 0])]);
    expect(placed.map((p) => [p.item.id, p.depth, p.visible])).toEqual([
      [2, 0, 0],
      [1, 1, 60],
    ]);
  });
});

describe('glisser une tâche', () => {
  const times = { start: at(2, 14), end: at(2, 15) };

  it('la déplace d’heure et de jour, en gardant sa durée', () => {
    expect(shiftTimes(times, 'move', 90, -1)).toEqual({ start: at(1, 15, 30), end: at(1, 16, 30) });
  });

  it('la garde dans sa journée, de 0 h à 23 h 45', () => {
    expect(shiftTimes(times, 'move', -900, 0)).toEqual({ start: at(2, 0), end: at(2, 1) });
    expect(shiftTimes(times, 'move', 900, 0)).toEqual({ start: at(2, 22, 45), end: at(2, 23, 45) });
  });

  it('l’allonge ou la raccourcit par le bas, sans changer de jour ni passer sous un quart d’heure', () => {
    expect(shiftTimes(times, 'resize', 45, 2)).toEqual({ start: times.start, end: at(2, 15, 45) });
    expect(shiftTimes(times, 'resize', -120, 0)).toEqual({ start: times.start, end: at(2, 14, 15) });
    expect(shiftTimes(times, 'resize', 900, 0)).toEqual({ start: times.start, end: at(2, 23, 45) });
  });
});

describe('couleurs', () => {
  it('sept couleurs de tâche ; un cours garde la sienne', () => {
    expect(COLOR_KEYS).toHaveLength(7);
    expect(courseColor(10)).toBe(courseColor(15));
    expect(courseColor(10)).not.toBe(courseColor(11));
  });
});

describe('brouillon', () => {
  const monday = new Date(2026, 9, 26);

  it('heures au quart d’heure, de 0 h à 23 h 45', () => {
    expect(TIME_OPTIONS[0]).toEqual({ value: '00:00', label: '0 h 00' });
    expect(TIME_OPTIONS.at(-1)).toEqual({ value: '23:45', label: '23 h 45' });
    expect(TIME_OPTIONS).toHaveLength(96);
  });

  it('un brouillon vide commence à l’heure donnée, ramenée dans la journée', () => {
    expect(emptyDraft('task', monday, 13, null)).toMatchObject({ date: '2026-10-26', start: '13:00', end: '14:00' });
    expect(emptyDraft('task', monday, -1, null)).toMatchObject({ start: '00:00', end: '01:00' });
    expect(emptyDraft('task', monday, 23, null)).toMatchObject({ start: '22:00', end: '23:00' });
  });

  it('une tâche donne son brouillon, et le brouillon redonne la tâche', () => {
    const task = {
      title: 'Tutorat',
      start: at(2, 14),
      end: at(2, 15, 30),
      courseId: 10,
      reminder: 30,
      notes: 'Salle B',
      color: 'rose' as const,
      done: true,
    };
    const draft = taskDraft({ ...task, id: 1 });
    expect(draft).toMatchObject({ kind: 'task', date: '2026-10-28', start: '14:00', end: '15:30' });
    expect(draftToTask({ ...draft, title: '  Tutorat ', notes: ' Salle B ' })).toEqual(task);
  });

  it('une séance hebdomadaire va jusqu’à sa date de fin ; sinon une seule fois', () => {
    const draft = { ...emptyDraft('session', monday, 9, 10), room: ' C1-4016 ', weekly: true, until: '2026-12-07' };
    expect(draftToSession(draft)).toEqual({
      courseId: 10,
      kind: 'Cours',
      room: 'C1-4016',
      start: toIso('2026-10-26', '09:00'),
      end: toIso('2026-10-26', '10:00'),
      until: toIso('2026-12-07'),
    });
    expect(draftToSession({ ...draft, weekly: false }).until).toBeNull();
  });

  it('dit ce qui manque, dans l’ordre des champs', () => {
    const task = { ...emptyDraft('task', monday, 9, null), title: 'Lire' };
    expect(draftError(task)).toBeNull();
    expect(draftError({ ...task, title: ' ' })).toBe('Donnez un titre à la tâche.');
    expect(draftError({ ...task, date: '' })).toBe('Choisissez une date.');
    expect(draftError({ ...task, date: '2026-10-31' })).toBe('Choisissez un jour de semaine.');
    expect(draftError({ ...task, end: '09:00' })).toBe('La fin doit suivre le début.');

    const session = { ...emptyDraft('session', monday, 9, 10), room: 'C1' };
    expect(draftError(session)).toBeNull();
    expect(draftError({ ...session, courseId: null })).toBe('Choisissez un cours.');
    expect(draftError({ ...session, room: '' })).toBe('Indiquez le local.');
    expect(draftError({ ...session, weekly: true, until: '' })).toBe('La répétition doit finir après la première séance.');
    expect(draftError({ ...session, weekly: true, until: '2026-10-19' })).toBe(
      'La répétition doit finir après la première séance.'
    );
    expect(draftError({ ...session, weekly: true, until: '2026-10-26' })).toBeNull();
  });
});
