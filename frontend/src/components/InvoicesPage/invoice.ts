import type { InvoiceSummary } from '../../types/domain.ts';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const money = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' });

/** Montant en dollars canadiens, à la québécoise : « 1 284,50 $ ». */
export function formatMoney(cents: number): string {
  return money.format(cents / 100);
}

/** Total de ce qui est dû pour la session, en cents. */
export function invoiceTotal(invoice: InvoiceSummary): number {
  return invoice.lines.reduce((sum, line) => sum + line.amountCents, 0);
}

/** Date AAAA-MM-JJ lue comme une date locale (et non à minuit UTC, la veille au Québec). */
function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
}

/** « 15 novembre 2026 ». */
export function formatDueDate(day: string): string {
  return new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    parseDay(day)
  );
}

/** Jours de calendrier entre aujourd'hui et l'échéance : 0 le jour même, négatif une fois passée. */
export function daysUntil(day: string, now: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((parseDay(day).getTime() - today.getTime()) / MS_PER_DAY);
}

export interface DueBadge {
  text: string;
  /** `late` : le jour même ou après, en rouge ; sinon, en jaune. */
  tone: 'soon' | 'late';
}

/** Pastille à côté de l'échéance : « Dans 16 jours », « Demain », « Aujourd'hui », « En retard ». */
export function dueBadge(days: number): DueBadge {
  if (days < 0) return { text: 'En retard', tone: 'late' };
  if (days === 0) return { text: "Aujourd'hui", tone: 'late' };
  if (days === 1) return { text: 'Demain', tone: 'soon' };
  return { text: `Dans ${days} jours`, tone: 'soon' };
}
