import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  dueBadge,
  formatDay,
  formatDueDate,
  formatMoney,
  invoiceTotal,
} from './invoice';

/** Intl sépare les milliers et le « $ » par des espaces insécables : on les compare en espaces. */
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('factures : calculs et formats', () => {
  it('montant en dollars canadiens, à la québécoise', () => {
    expect(plain(formatMoney(128_450))).toBe('1 284,50 $');
    expect(plain(formatMoney(0))).toBe('0,00 $');
  });

  it('total : la somme des lignes, en cents', () => {
    expect(
      invoiceTotal({
        session: 'automne 2026',
        lines: [
          { label: 'A', amountCents: 112_000 },
          { label: 'B', amountCents: 13_450 },
        ],
      })
    ).toBe(125_450);
    expect(invoiceTotal({ session: 'automne 2026', lines: [] })).toBe(0);
  });

  it('échéance en toutes lettres, lue comme une date locale', () => {
    expect(formatDueDate('2026-11-15')).toBe('15 novembre 2026');
  });

  it('jour d’une date, en toutes lettres', () => {
    expect(formatDay(new Date(2026, 9, 30, 23, 30))).toBe('30 octobre 2026');
  });

  it('jours de calendrier avant l’échéance, quelle que soit l’heure', () => {
    const lateEvening = new Date(2026, 9, 30, 23, 30);
    expect(daysUntil('2026-11-15', lateEvening)).toBe(16);
    expect(daysUntil('2026-10-30', lateEvening)).toBe(0);
    expect(daysUntil('2026-10-29', lateEvening)).toBe(-1);
  });

  it('pastille : jaune avant l’échéance, rouge le jour même et après', () => {
    expect(dueBadge(16)).toEqual({ text: 'Dans 16 jours', tone: 'soon' });
    expect(dueBadge(1)).toEqual({ text: 'Demain', tone: 'soon' });
    expect(dueBadge(0)).toEqual({ text: "Aujourd'hui", tone: 'late' });
    expect(dueBadge(-3)).toEqual({ text: 'En retard', tone: 'late' });
  });
});
