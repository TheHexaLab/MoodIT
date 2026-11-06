import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchEnrolledStudents,
  fetchFeeSchedule,
  fetchInvoice,
  invoicesAvailable,
  saveFeeSchedule,
} from './dashboardApi.ts';
import { demoInvoice, resetDemoBilling, sessionName } from '../../mocks/invoicesData.ts';
import { invoiceFromSchedule, invoiceTotal } from '../../components/InvoicesPage/invoice.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  resetDemoBilling();
});

const NOW = new Date(2026, 9, 30, 9, 0);

describe('factures : données fictives (#207)', () => {
  it('n’existent qu’en développement, jamais en production', async () => {
    expect(invoicesAvailable()).toBe(true);
    vi.stubEnv('DEV', false);
    expect(invoicesAvailable()).toBe(false);
    await expect(fetchInvoice()).rejects.toThrow('Factures indisponibles');
  });

  it('la facture de l’étudiant découle de la tarification : 15 crédits au tarif du Québec + frais', async () => {
    const invoice = await fetchInvoice(NOW);
    expect(invoice.session).toBe('automne 2026');
    expect(invoice.dueDate).toBe('2026-11-15');
    expect(invoice.lines.map((line) => [line.label, line.amountCents])).toEqual([
      ['Droits de scolarité', 157_500],
      ['Frais afférents', 13_500],
      ['Frais technologiques', 4_500],
      ['Association étudiante', 2_500],
      ['Assurance collective', 15_000],
    ]);
  });

  it('une tarification enregistrée change la facture de l’étudiant', async () => {
    const schedule = await fetchFeeSchedule(NOW);
    await saveFeeSchedule({
      ...schedule,
      statuses: schedule.statuses.map((status) =>
        status.id === 'quebec' ? { ...status, creditPriceCents: 10_000 } : status
      ),
      fees: [],
    });
    const invoice = await fetchInvoice(NOW);
    expect(invoice.lines.map((line) => [line.label, line.amountCents])).toEqual([
      ['Droits de scolarité', 150_000],
    ]);
  });

  it('l’échéance change de mois et d’année au besoin', async () => {
    const invoice = await fetchInvoice(new Date(2026, 11, 20));
    expect(invoice.dueDate).toBe('2027-01-05');
  });

  it('la session suit le mois : hiver, été, automne', () => {
    expect(sessionName(new Date(2027, 0, 10))).toBe('hiver 2027');
    expect(sessionName(new Date(2027, 3, 30))).toBe('hiver 2027');
    expect(sessionName(new Date(2027, 4, 1))).toBe('été 2027');
    expect(sessionName(new Date(2027, 7, 31))).toBe('été 2027');
    expect(sessionName(new Date(2027, 8, 1))).toBe('automne 2027');
  });
});

describe('factures : états de démonstration', () => {
  it('à payer par défaut, sans paiement', () => {
    expect(demoInvoice(NOW).payments).toBeUndefined();
  });

  it('paiement partiel : 500 $ reçus il y a 5 jours', () => {
    expect(demoInvoice(NOW, 'partial').payments).toEqual([
      { date: '2026-10-25', amountCents: 50_000, method: 'Virement bancaire' },
    ]);
  });

  it('payée : deux paiements qui couvrent le total', () => {
    const payments = demoInvoice(NOW, 'paid').payments ?? [];
    expect(payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(193_000);
  });

  it('en retard : l’échéance passée depuis 12 jours, et des intérêts à 2 % par mois', () => {
    const invoice = demoInvoice(NOW, 'late');
    expect(invoice.dueDate).toBe('2026-10-18');
    const interest = invoice.lines.at(-1)!;
    expect(interest.label).toBe('Intérêts de retard');
    expect(interest.detail).toBe('2 % par mois · 1 mois de retard');
    // 2 % de 1 930 $ pour le premier mois : 38,60 $.
    expect(interest.amountCents).toBe(3_860);
    expect(invoice.payments).toBeUndefined();
  });

  it('rien à payer : aucune ligne', () => {
    expect(demoInvoice(NOW, 'none')).toEqual({ session: 'automne 2026', lines: [] });
  });
});

describe('tarification et étudiants (administration)', () => {
  it('tarification de départ : un prix du crédit par statut ; une copie à chaque appel', async () => {
    const schedule = await fetchFeeSchedule(NOW);
    expect(schedule).toMatchObject({
      session: 'automne 2026',
      statuses: [
        { id: 'quebec', label: 'Résident du Québec', creditPriceCents: 10_500 },
        { id: 'canada', label: 'Canadien hors Québec', creditPriceCents: 31500 },
        { id: 'france', label: 'Français (entente)', creditPriceCents: 31500 },
        { id: 'international', label: 'International', creditPriceCents: 85000 },
      ],
      dueDate: '2026-11-15',
      lateInterestPercent: 2,
    });
    expect(schedule.fees.map((fee) => [fee.label, fee.basis, fee.optional ?? false])).toEqual([
      ['Frais afférents', 'perCredit', false],
      ['Frais technologiques', 'perSession', false],
      ['Association étudiante', 'perSession', true],
      ['Assurance collective', 'perSession', true],
    ]);
    schedule.fees.length = 0;
    expect((await fetchFeeSchedule(NOW)).fees).toHaveLength(4);
  });

  it('une tarification enregistrée est relue telle quelle', async () => {
    const next = {
      session: 'automne 2026',
      statuses: [
        { id: 'quebec', label: 'Résident du Québec', creditPriceCents: 11_000 },
        { id: 'canada', label: 'Canadien hors Québec', creditPriceCents: 33_000 },
        { id: 'international', label: 'International', creditPriceCents: 90_000 },
      ],
      dueDate: '2026-12-01',
      fees: [{ label: 'Frais technologiques', amountCents: 4_500 }],
    };
    expect(await saveFeeSchedule(next)).toEqual(next);
    expect(await fetchFeeSchedule(NOW)).toEqual(next);
  });

  it('seize étudiants : matricule, programme, statut et crédits ; payés selon leur facture', async () => {
    const students = await fetchEnrolledStudents(NOW);
    expect(students).toHaveLength(16);
    // Deux étudiants français, à l'entente France-Québec.
    expect(students.filter((student) => student.residency === 'france')).toHaveLength(2);
    expect(students[0]).toMatchObject({
      id: 1,
      name: 'Camille Lavoie',
      email: 'camille.lavoie@exemple.ca',
      program: 'Génie informatique',
      residency: 'quebec',
      credits: 15,
      payments: [],
    });
    expect(students[0].studentNumber).toMatch(/^\d{8}$/);
    // Les accents tombent dans le courriel.
    expect(students[10].email).toBe('emile.fortin@exemple.ca');
    // Payé en entier : exactement le total de sa facture.
    const schedule = await fetchFeeSchedule(NOW);
    const jeremie = students[1];
    expect(jeremie.payments[0].amountCents).toBe(
      invoiceTotal(invoiceFromSchedule(schedule, jeremie))
    );
    // Retiré de l'assurance.
    expect(students[3].optedOut).toEqual(['Assurance collective']);
  });

  it('jamais en production', async () => {
    vi.stubEnv('DEV', false);
    await expect(fetchFeeSchedule(NOW)).rejects.toThrow('Factures indisponibles');
    await expect(
      saveFeeSchedule({
        session: 's',
        statuses: [
          { id: 'quebec', label: 'Résident du Québec', creditPriceCents: 1 },
          { id: 'canada', label: 'Canadien hors Québec', creditPriceCents: 1 },
          { id: 'international', label: 'International', creditPriceCents: 1 },
        ],
        dueDate: '2026-12-01',
        fees: [],
      })
    ).rejects.toThrow('Factures indisponibles');
    await expect(fetchEnrolledStudents(NOW)).rejects.toThrow('Factures indisponibles');
  });
});
