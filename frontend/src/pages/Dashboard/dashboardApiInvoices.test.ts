import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchEnrolledStudents,
  fetchFeeSchedule,
  fetchInvoice,
  invoicesAvailable,
  recordStudentPayment,
  saveFeeSchedule,
} from './dashboardApi.ts';
import { demoInvoice, resetDemoBilling, sessionName } from '../../mocks/invoicesData.ts';

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

  it('la facture de l’étudiant découle de la tarification : 15 crédits × 75 $ + frais communs', async () => {
    const invoice = await fetchInvoice(NOW);
    expect(invoice.session).toBe('automne 2026');
    expect(invoice.dueDate).toBe('2026-11-15');
    expect(invoice.lines).toEqual([
      {
        label: 'Droits de scolarité',
        detail: expect.stringContaining('15 crédits ×'),
        amountCents: 112_500,
      },
      {
        label: 'Frais afférents',
        detail: 'Services aux étudiants et technologies',
        amountCents: 13_450,
      },
      { label: 'Assurance collective', amountCents: 3_000 },
    ]);
  });

  it('une tarification enregistrée change la facture de l’étudiant', async () => {
    const schedule = await fetchFeeSchedule(NOW);
    await saveFeeSchedule({ ...schedule, creditPriceCents: 10_000, fees: [] });
    const invoice = await fetchInvoice(NOW);
    expect(invoice.lines).toEqual([
      expect.objectContaining({ label: 'Droits de scolarité', amountCents: 150_000 }),
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
    expect(payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(128_950);
  });

  it('rien à payer : aucune ligne', () => {
    expect(demoInvoice(NOW, 'none')).toEqual({ session: 'automne 2026', lines: [] });
  });
});

describe('tarification et étudiants (administration)', () => {
  it('tarification de départ ; une copie à chaque appel', async () => {
    const schedule = await fetchFeeSchedule(NOW);
    expect(schedule).toMatchObject({
      session: 'automne 2026',
      creditPriceCents: 7_500,
      dueDate: '2026-11-15',
    });
    expect(schedule.fees.map((fee) => fee.label)).toEqual([
      'Frais afférents',
      'Assurance collective',
    ]);
    schedule.fees.length = 0;
    expect((await fetchFeeSchedule(NOW)).fees).toHaveLength(2);
  });

  it('une tarification enregistrée est relue telle quelle', async () => {
    const next = {
      session: 'automne 2026',
      creditPriceCents: 8_000,
      dueDate: '2026-12-01',
      fees: [{ label: 'Frais technologiques', amountCents: 4_500 }],
    };
    expect(await saveFeeSchedule(next)).toEqual(next);
    expect(await fetchFeeSchedule(NOW)).toEqual(next);
  });

  it('cinq étudiants, avec leurs crédits ; Jérémie a tout payé', async () => {
    const students = await fetchEnrolledStudents(NOW);
    expect(students.map((student) => [student.name, student.credits])).toEqual([
      ['Camille Lavoie', 15],
      ['Jérémie Tremblay', 12],
      ['Amira Benali', 15],
      ['Noah Gagnon', 9],
      ['Léa Côté', 6],
    ]);
    // 12 crédits × 75 $ + 164,50 $ de frais communs.
    expect(students[1].payments[0].amountCents).toBe(106_450);
  });

  it('un paiement enregistré s’ajoute à l’étudiant', async () => {
    await fetchEnrolledStudents(NOW);
    const updated = await recordStudentPayment(1, { date: '2026-10-30', amountCents: 10_000 });
    expect(updated.payments).toEqual([{ date: '2026-10-30', amountCents: 10_000 }]);
    expect((await fetchEnrolledStudents(NOW))[0].payments).toHaveLength(1);
  });

  it('paiement pour un étudiant inconnu, ou avant tout chargement : erreur', async () => {
    await expect(recordStudentPayment(1, { date: '2026-10-30', amountCents: 1 })).rejects.toThrow(
      'Étudiant introuvable'
    );
    await fetchEnrolledStudents(NOW);
    await expect(recordStudentPayment(999, { date: '2026-10-30', amountCents: 1 })).rejects.toThrow(
      'Étudiant introuvable'
    );
  });

  it('jamais en production', async () => {
    vi.stubEnv('DEV', false);
    await expect(fetchFeeSchedule(NOW)).rejects.toThrow('Factures indisponibles');
    await expect(
      saveFeeSchedule({ session: 's', creditPriceCents: 1, dueDate: '2026-12-01', fees: [] })
    ).rejects.toThrow('Factures indisponibles');
    await expect(fetchEnrolledStudents(NOW)).rejects.toThrow('Factures indisponibles');
    await expect(recordStudentPayment(1, { date: '2026-10-30', amountCents: 1 })).rejects.toThrow(
      'Factures indisponibles'
    );
  });
});
