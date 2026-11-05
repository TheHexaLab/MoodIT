import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import InvoicesPage, { type InvoiceState } from './InvoicesPage';
import { formatMoney } from './invoice';
import type { InvoiceSummary } from '../../types/domain';

afterEach(cleanup);

const NOW = new Date(2026, 9, 30, 10, 0);

const INVOICE: InvoiceSummary = {
  session: 'automne 2026',
  dueDate: '2026-11-15',
  lines: [
    { label: 'Droits de scolarité', detail: 'Automne 2026, 15 crédits', amountCents: 112_000 },
    { label: 'Frais afférents', detail: 'Services aux étudiants et technologies', amountCents: 13_450 },
    { label: 'Assurance collective', amountCents: 3_000 },
  ],
};

/** Montant tel que Testing Library le lit : ses espaces insécables deviennent des espaces. */
const shown = (cents: number) => formatMoney(cents).replace(/\s/g, ' ');

function renderPage(state: InvoiceState, paymentInfoUrl?: string) {
  const props = { state, onRetry: vi.fn(), paymentInfoUrl, now: NOW };
  render(<InvoicesPage {...props} />);
  return props;
}

describe('InvoicesPage', () => {
  it('solde, échéance et compte à rebours, comme dans la maquette', () => {
    renderPage({ status: 'ready', invoice: INVOICE });
    expect(screen.getByRole('heading', { level: 1, name: 'Factures' })).toBeTruthy();
    expect(screen.getByText("Ce que vous devez pour la session d'automne 2026")).toBeTruthy();
    expect(screen.getByText('Solde à payer')).toBeTruthy();
    // Le solde, puis le total du détail.
    expect(screen.getAllByText(shown(128_450))).toHaveLength(2);
    expect(screen.getByText('Échéance le 15 novembre 2026', { exact: false })).toBeTruthy();
    expect(screen.getByText('Dans 16 jours').className).toMatch(/badgeSoon/);
  });

  it('le détail des montants est un tableau : une ligne par montant, puis le total', () => {
    renderPage({ status: 'ready', invoice: INVOICE });
    const table = screen.getByRole('table', { name: 'Détail des montants dus' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByRole('rowheader').textContent).toBe(
      'Droits de scolaritéAutomne 2026, 15 crédits'
    );
    expect(within(rows[0]).getByRole('cell').textContent).toBe(formatMoney(112_000));
    // Une ligne sans précision n'a que son libellé.
    expect(within(rows[2]).getByRole('rowheader').textContent).toBe('Assurance collective');
    expect(within(rows[3]).getByRole('rowheader').textContent).toBe('Total à payer');
    expect(within(rows[3]).getByRole('cell').textContent).toBe(formatMoney(128_450));
  });

  it('« Comment payer » : grisé tant que la page de l’établissement n’est pas fournie', () => {
    renderPage({ status: 'ready', invoice: INVOICE });
    const how = screen.getByRole('button', { name: 'Comment payer' });
    expect(how.getAttribute('aria-disabled')).toBe('true');
    expect(how.getAttribute('title')).toBe('Bientôt disponible');
    fireEvent.click(how);
    expect(screen.queryByRole('link', { name: 'Comment payer' })).toBeNull();
  });

  it('« Comment payer » ouvre la page de l’établissement dans un nouvel onglet', () => {
    renderPage({ status: 'ready', invoice: INVOICE }, 'https://exemple.ca/payer');
    const how = screen.getByRole('link', { name: 'Comment payer' });
    expect(how.getAttribute('href')).toBe('https://exemple.ca/payer');
    expect(how.getAttribute('target')).toBe('_blank');
    expect(how.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByRole('button', { name: 'Comment payer' })).toBeNull();
  });

  it('pas de carte d’historique ni de reçus', () => {
    renderPage({ status: 'ready', invoice: INVOICE });
    expect(screen.queryByText('Factures payées et reçus')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ouvrir mon profil' })).toBeNull();
  });

  it('échéance passée : pastille rouge « En retard »', () => {
    renderPage({ status: 'ready', invoice: { ...INVOICE, dueDate: '2026-10-20' } });
    expect(screen.getByText('En retard').className).toMatch(/badgeLate/);
  });

  it('sans échéance connue : le solde seul', () => {
    renderPage({ status: 'ready', invoice: { ...INVOICE, dueDate: undefined } });
    expect(screen.queryByText('Échéance', { exact: false })).toBeNull();
    expect(screen.getAllByText(shown(128_450))).toHaveLength(2);
  });

  it('rien à payer : un solde nul, sans « Comment payer » ni détail', () => {
    renderPage({ status: 'ready', invoice: { session: 'automne 2026', lines: [] } });
    expect(screen.getByText(shown(0))).toBeTruthy();
    expect(screen.getByText('Rien à payer').className).toMatch(/badgePaid/);
    expect(screen.getByText("Aucun montant dû pour la session d'automne 2026.", { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Comment payer' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('chargement : un état annoncé, sans montant', () => {
    renderPage({ status: 'loading' });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Chargement de vos factures…');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Ce que vous devez pour la session')).toBeTruthy();
    expect(screen.queryByText('Solde à payer')).toBeNull();
  });

  it('erreur : un message, et « Réessayer » recharge', () => {
    const props = renderPage({ status: 'error' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Impossible de charger vos factures.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('sans date fournie : le compte à rebours part d’aujourd’hui', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 14, 12, 0));
    try {
      render(
        <InvoicesPage
          state={{ status: 'ready', invoice: INVOICE }}
          onRetry={vi.fn()}
        />
      );
      expect(screen.getByText('Demain')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
