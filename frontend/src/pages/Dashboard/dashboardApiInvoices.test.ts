import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInvoice,
  fetchInvoice,
  fetchIssuedInvoices,
  invoicesAvailable,
  recordInvoicePayment,
} from './dashboardApi.ts';
import { demoInvoice, resetDemoIssuedInvoices, sessionName } from '../../mocks/invoicesData.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  resetDemoIssuedInvoices();
});

describe('factures : données fictives (#207)', () => {
  it('n’existent qu’en développement, jamais en production', async () => {
    expect(invoicesAvailable()).toBe(true);
    vi.stubEnv('DEV', false);
    expect(invoicesAvailable()).toBe(false);
    await expect(fetchInvoice()).rejects.toThrow('Factures indisponibles');
  });

  it('les montants des maquettes, avec une échéance dans 16 jours', async () => {
    const invoice = await fetchInvoice(new Date(2026, 9, 30, 9, 0));
    expect(invoice.session).toBe('automne 2026');
    expect(invoice.dueDate).toBe('2026-11-15');
    expect(invoice.lines).toEqual([
      { label: 'Droits de scolarité', detail: 'Automne 2026, 15 crédits', amountCents: 112_000 },
      {
        label: 'Frais afférents',
        detail: 'Services aux étudiants et technologies',
        amountCents: 13_450,
      },
      { label: 'Assurance collective', detail: 'Automne 2026', amountCents: 3_000 },
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
  const NOW = new Date(2026, 9, 30);

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
    expect(payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(128_450);
  });

  it('rien à payer : aucune ligne', () => {
    expect(demoInvoice(NOW, 'none')).toEqual({ session: 'automne 2026', lines: [] });
  });
});

describe('factures émises (administration)', () => {
  const NOW = new Date(2026, 9, 30);
  const DRAFT = {
    studentName: 'Zoé Martin',
    studentEmail: '',
    dueDate: '2026-12-01',
    lines: [{ label: 'Droits de scolarité', amountCents: 50_000 }],
  };

  it('cinq factures de départ, dans chaque état ; une copie à chaque appel', async () => {
    const first = await fetchIssuedInvoices(NOW);
    expect(first.map((invoice) => invoice.studentName)).toEqual([
      'Camille Lavoie',
      'Jérémie Tremblay',
      'Amira Benali',
      'Noah Gagnon',
      'Léa Côté',
    ]);
    first[0].studentName = 'modifié';
    expect((await fetchIssuedInvoices(NOW))[0].studentName).toBe('Camille Lavoie');
  });

  it('une facture émise arrive en tête, sans courriel vide', async () => {
    const created = await createInvoice(DRAFT, NOW);
    expect(created).toMatchObject({
      studentName: 'Zoé Martin',
      session: 'automne 2026',
      payments: [],
    });
    expect(created.studentEmail).toBeUndefined();
    expect((await fetchIssuedInvoices(NOW))[0].id).toBe(created.id);
  });

  it('créée avant toute lecture : les factures de départ restent là', async () => {
    await createInvoice(DRAFT, NOW);
    expect(await fetchIssuedInvoices(NOW)).toHaveLength(6);
  });

  it('un paiement enregistré s’ajoute à la facture', async () => {
    const [camille] = await fetchIssuedInvoices(NOW);
    const updated = await recordInvoicePayment(camille.id, {
      date: '2026-10-30',
      amountCents: 128_450,
    });
    expect(updated.payments).toEqual([{ date: '2026-10-30', amountCents: 128_450 }]);
  });

  it('paiement sur une facture inconnue, ou sans factures chargées : erreur', async () => {
    await expect(recordInvoicePayment(1, { date: '2026-10-30', amountCents: 1 })).rejects.toThrow(
      'Facture introuvable'
    );
    await fetchIssuedInvoices(NOW);
    await expect(recordInvoicePayment(999, { date: '2026-10-30', amountCents: 1 })).rejects.toThrow(
      'Facture introuvable'
    );
  });

  it('jamais en production', async () => {
    vi.stubEnv('DEV', false);
    await expect(fetchIssuedInvoices(NOW)).rejects.toThrow('Factures indisponibles');
    await expect(createInvoice(DRAFT, NOW)).rejects.toThrow('Factures indisponibles');
    await expect(recordInvoicePayment(1, { date: '2026-10-30', amountCents: 1 })).rejects.toThrow(
      'Factures indisponibles'
    );
  });
});
