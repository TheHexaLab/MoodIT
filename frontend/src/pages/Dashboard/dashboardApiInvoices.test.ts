import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchInvoice, invoicesAvailable } from './dashboardApi.ts';
import { sessionName } from '../../mocks/invoicesData.ts';

afterEach(() => {
  vi.unstubAllEnvs();
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
