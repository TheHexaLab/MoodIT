import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  dueBadge,
  formatDay,
  formatDueDate,
  formatMoney,
  invoiceBalance,
  invoicePaid,
  invoiceStatus,
  invoiceTotal,
  isoDay,
  lastPaymentDate,
  parseAmount,
  sessionName,
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

describe('factures : paiements et état', () => {
  const lines = [{ label: 'A', amountCents: 100_000 }];
  const NOW = new Date(2026, 9, 30);

  it('payé, solde et dernier paiement', () => {
    const invoice = {
      session: 'automne 2026',
      lines,
      payments: [
        { date: '2026-10-28', amountCents: 30_000 },
        { date: '2026-10-12', amountCents: 20_000 },
      ],
    };
    expect(invoicePaid(invoice)).toBe(50_000);
    expect(invoiceBalance(invoice)).toBe(50_000);
    expect(lastPaymentDate(invoice)).toBe('2026-10-28');
  });

  it('sans paiement : rien de payé, pas de date ; un trop-payé ne rend pas le solde négatif', () => {
    expect(invoicePaid({ session: 's', lines })).toBe(0);
    expect(lastPaymentDate({ session: 's', lines })).toBeUndefined();
    expect(
      invoiceBalance({
        session: 's',
        lines,
        payments: [{ date: '2026-10-01', amountCents: 150_000 }],
      })
    ).toBe(0);
  });

  it('état : rien à payer, payée, en retard, à payer', () => {
    expect(invoiceStatus({ session: 's', lines: [] }, NOW)).toBe('none');
    expect(
      invoiceStatus(
        { session: 's', lines, payments: [{ date: '2026-10-01', amountCents: 100_000 }] },
        NOW
      )
    ).toBe('paid');
    expect(invoiceStatus({ session: 's', lines, dueDate: '2026-10-29' }, NOW)).toBe('late');
    expect(invoiceStatus({ session: 's', lines, dueDate: '2026-10-30' }, NOW)).toBe('due');
    expect(invoiceStatus({ session: 's', lines }, NOW)).toBe('due');
  });

  it('date du jour au format AAAA-MM-JJ', () => {
    expect(isoDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('montant saisi : virgule ou point, espaces et « $ » tolérés', () => {
    expect(parseAmount('1 120,50')).toBe(112_050);
    expect(parseAmount('1120.5')).toBe(112_050);
    expect(parseAmount('30 $')).toBe(3_000);
    expect(parseAmount('')).toBeNaN();
    expect(parseAmount('abc')).toBeNaN();
    expect(parseAmount('1,234')).toBeNaN();
  });

  it('la session suit le mois', () => {
    expect(sessionName(new Date(2026, 9, 30))).toBe('automne 2026');
  });
});
