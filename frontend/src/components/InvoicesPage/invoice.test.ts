import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  dueBadge,
  formatDay,
  formatDueDate,
  formatMoney,
  invoiceBalance,
  invoiceFromSchedule,
  invoicePaid,
  invoiceStatus,
  invoiceTotal,
  isoDay,
  lastPaymentDate,
  parseAmount,
  sessionName,
  appliedFees,
  formatPercent,
  invoiceInterest,
  lateInterestCents,
  monthsLate,
  statusLabel,
  statusPrice,
  creditsLabel,
  feeCents,
  feesCents,
  tuitionCents,
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

describe('factures : calcul à partir de la tarification', () => {
  const SCHEDULE = {
    session: 'automne 2026',
    statuses: [
      { id: 'quebec', label: 'Résident du Québec', creditPriceCents: 10_500 },
      { id: 'canada', label: 'Canadien hors Québec', creditPriceCents: 31_500 },
      { id: 'international', label: 'International', creditPriceCents: 85_000 },
    ],
    dueDate: '2026-11-15',
    fees: [
      { label: 'Frais afférents', amountCents: 900, basis: 'perCredit' as const },
      { label: 'Frais technologiques', detail: 'Session', amountCents: 4_500 },
      { label: 'Assurance collective', amountCents: 15_000, optional: true },
    ],
  };

  it('nom et prix d’un statut ; un statut inconnu : « Statut inconnu », 0 $', () => {
    expect(statusLabel(SCHEDULE, 'canada')).toBe('Canadien hors Québec');
    expect(statusPrice(SCHEDULE, 'canada')).toBe(31_500);
    expect(statusLabel(SCHEDULE, 'retiré')).toBe('Statut inconnu');
    expect(statusPrice(SCHEDULE, 'retiré')).toBe(0);
  });

  it('droits : crédits × prix du crédit ; « 1 crédit » au singulier', () => {
    expect(tuitionCents(15, 10_500)).toBe(157_500);
    expect(tuitionCents(0, 10_500)).toBe(0);
    expect(creditsLabel(1)).toBe('1 crédit');
    expect(creditsLabel(15)).toBe('15 crédits');
  });

  it('un frais par crédit se multiplie ; un frais de session reste fixe', () => {
    expect(feeCents(SCHEDULE.fees[0], 15)).toBe(13_500);
    expect(feeCents(SCHEDULE.fees[1], 15)).toBe(4_500);
  });

  it('un frais facultatif refusé ne s’applique pas ; un frais obligatoire, toujours', () => {
    expect(appliedFees(SCHEDULE.fees)).toHaveLength(3);
    expect(
      appliedFees(SCHEDULE.fees, ['Assurance collective', 'Frais technologiques']).map(
        (fee) => fee.label
      )
    ).toEqual(['Frais afférents', 'Frais technologiques']);
    expect(feesCents(SCHEDULE.fees, 15)).toBe(33_000);
    expect(feesCents(SCHEDULE.fees, 15, ['Assurance collective'])).toBe(18_000);
  });

  it('facture d’un résident : les droits à son tarif, puis chaque frais', () => {
    const invoice = invoiceFromSchedule(SCHEDULE, { credits: 15, residency: 'quebec' }, [
      { date: '2026-10-30', amountCents: 100 },
    ]);
    expect(invoice.session).toBe('automne 2026');
    expect(invoice.dueDate).toBe('2026-11-15');
    expect(invoice.lines.map((line) => [line.label, line.amountCents])).toEqual([
      ['Droits de scolarité', 157_500],
      ['Frais afférents', 13_500],
      ['Frais technologiques', 4_500],
      ['Assurance collective', 15_000],
    ]);
    expect(plain(invoice.lines[0].detail ?? '')).toBe('15 crédits × 105,00 $');
    expect(plain(invoice.lines[1].detail ?? '')).toBe('15 crédits × 9,00 $');
    expect(invoice.lines[2].detail).toBe('Session');
    expect(invoiceTotal(invoice)).toBe(190_500);
    expect(invoice.payments).toEqual([{ date: '2026-10-30', amountCents: 100 }]);
  });

  it('étudiant international, retiré de l’assurance, sans paiement', () => {
    const invoice = invoiceFromSchedule(SCHEDULE, {
      credits: 1,
      residency: 'international',
      optedOut: ['Assurance collective'],
    });
    expect(plain(invoice.lines[0].detail ?? '')).toBe('1 crédit × 850,00 $');
    expect(invoiceTotal(invoice)).toBe(85_000 + 900 + 4_500);
    expect(invoice.payments).toEqual([]);
  });
});

describe('factures : intérêts de retard', () => {
  const SCHEDULE = {
    session: 'automne 2026',
    statuses: [{ id: 'quebec', label: 'Résident du Québec', creditPriceCents: 10_000 }],
    dueDate: '2026-11-15',
    fees: [],
    lateInterestPercent: 2,
  };
  const STUDENT = { credits: 10, residency: 'quebec' };

  it('mois de retard commencés : 1 du 1er au 30e jour, 2 ensuite', () => {
    expect(monthsLate(0)).toBe(0);
    expect(monthsLate(-5)).toBe(0);
    expect(monthsLate(1)).toBe(1);
    expect(monthsLate(30)).toBe(1);
    expect(monthsLate(31)).toBe(2);
  });

  it('intérêts : solde × taux mensuel × mois, arrondis au cent', () => {
    expect(lateInterestCents(100_000, 2, 1)).toBe(2_000);
    expect(lateInterestCents(100_000, 2, 3)).toBe(6_000);
    expect(lateInterestCents(100_000, 2, 0)).toBe(0);
    expect(lateInterestCents(0, 2, 1)).toBe(0);
    expect(lateInterestCents(100_000, 0, 1)).toBe(0);
    expect(formatPercent(2.5)).toBe('2,5 %');
    expect(formatPercent(2)).toBe('2 %');
  });

  it('avant ou le jour de l’échéance, ou sans date : pas d’intérêts', () => {
    expect(invoiceFromSchedule(SCHEDULE, STUDENT).lines).toHaveLength(1);
    expect(invoiceFromSchedule(SCHEDULE, STUDENT, [], new Date(2026, 10, 15)).lines).toHaveLength(
      1
    );
  });

  it('après l’échéance : 2 % du solde impayé pour le premier mois', () => {
    const invoice = invoiceFromSchedule(
      SCHEDULE,
      STUDENT,
      [{ date: '2026-11-01', amountCents: 50_000 }],
      new Date(2026, 10, 25)
    );
    const interest = invoice.lines.at(-1)!;
    expect(interest.label).toBe('Intérêts de retard');
    expect(interest.detail).toBe('2 % par mois · 1 mois de retard');
    // Sur 500 $ restants : 10,00 $.
    expect(interest.amountCents).toBe(1_000);
    expect(invoiceInterest(invoice)).toBe(1_000);
    expect(invoiceBalance(invoice)).toBe(51_000);
  });

  it('un deuxième mois commencé double les intérêts ; payée ou sans taux : rien', () => {
    const twoMonths = invoiceFromSchedule(SCHEDULE, STUDENT, [], new Date(2026, 11, 16));
    expect(twoMonths.lines.at(-1)!.detail).toBe('2 % par mois · 2 mois de retard');
    expect(invoiceInterest(twoMonths)).toBe(4_000);
    const paid = invoiceFromSchedule(
      SCHEDULE,
      STUDENT,
      [{ date: '2026-11-01', amountCents: 100_000 }],
      new Date(2026, 10, 25)
    );
    expect(invoiceInterest(paid)).toBe(0);
    const noRate = invoiceFromSchedule(
      { ...SCHEDULE, lateInterestPercent: undefined },
      STUDENT,
      [],
      new Date(2026, 10, 25)
    );
    expect(invoiceInterest(noRate)).toBe(0);
  });
});
