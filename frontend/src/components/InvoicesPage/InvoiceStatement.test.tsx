import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import InvoiceStatement from './InvoiceStatement';
import { formatMoney } from './invoice';

afterEach(cleanup);

const NOW = new Date(2026, 9, 30);
const shown = (cents: number) => formatMoney(cents).replace(/\s/g, ' ');

describe('InvoiceStatement', () => {
  it('en-tête, informations, détail et solde', () => {
    render(
      <InvoiceStatement
        invoice={{
          session: 'automne 2026',
          dueDate: '2026-11-15',
          lines: [
            {
              label: 'Droits de scolarité',
              detail: 'Automne 2026, 15 crédits',
              amountCents: 112_000,
            },
            { label: 'Assurance collective', amountCents: 3_000 },
          ],
        }}
        studentName="Camille Lavoie"
        establishmentName="Université Exemple"
        now={NOW}
      />
    );
    expect(screen.getByText('Université Exemple')).toBeTruthy();
    // Caché à l'écran (display: none hors impression) : hidden pour l'atteindre par son rôle.
    expect(screen.getByRole('heading', { name: 'Relevé de compte', hidden: true })).toBeTruthy();
    expect(screen.getByText('Camille Lavoie')).toBeTruthy();
    expect(screen.getByText('Automne 2026')).toBeTruthy();
    expect(screen.getAllByText('30 octobre 2026')).toHaveLength(1);
    expect(screen.getByText('15 novembre 2026')).toBeTruthy();
    const rows = within(screen.getByRole('table', { hidden: true })).getAllByRole('row', {
      hidden: true,
    });
    expect(rows).toHaveLength(4);
    expect(rows[1].textContent).toContain('Automne 2026, 15 crédits');
    // Le total du tableau, puis le solde encadré.
    expect(screen.getAllByText(shown(115_000))).toHaveLength(2);
    expect(screen.getByText('Avant le 15 novembre 2026')).toBeTruthy();
    expect(screen.getByText('Produit le 30 octobre 2026.')).toBeTruthy();
  });

  it('rien à payer, sans nom ni établissement : des valeurs neutres', () => {
    render(<InvoiceStatement invoice={{ session: 'hiver 2027', lines: [] }} now={NOW} />);
    expect(screen.getByText('Établissement')).toBeTruthy();
    expect(screen.getByText('Aucun montant dû pour cette session.')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getAllByText(shown(0))).toHaveLength(2);
    expect(screen.queryByText(/^Avant le/)).toBeNull();
  });
});
