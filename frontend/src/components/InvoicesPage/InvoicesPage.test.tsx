import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    {
      label: 'Frais afférents',
      detail: 'Services aux étudiants et technologies',
      amountCents: 13_450,
    },
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

  it('« Enregistrer en PDF » ouvre la fenêtre d’impression du navigateur', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    try {
      renderPage({ status: 'ready', invoice: INVOICE });
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer en PDF' }));
      expect(print).toHaveBeenCalledOnce();
      // Le relevé n'existe que pendant l'impression.
      expect(screen.queryByText('Relevé de compte')).toBeNull();
    } finally {
      print.mockRestore();
    }
  });

  it('pendant l’impression : le relevé de compte remplace la page, puis disparaît', () => {
    render(
      <InvoicesPage
        state={{ status: 'ready', invoice: INVOICE }}
        onRetry={vi.fn()}
        studentName="Camille Lavoie"
        establishmentName="Université Exemple"
        now={NOW}
      />
    );
    const page = screen.getByRole('region', { name: 'Contenu principal' });
    act(() => {
      window.dispatchEvent(new Event('beforeprint'));
    });
    expect(page.className).toMatch(/printing/);
    // Le relevé n'est visible qu'à l'impression (display: none à l'écran) : hidden pour l'atteindre.
    const statement = screen.getByRole('article', { hidden: true });
    expect(
      within(statement).getByRole('heading', { name: 'Relevé de compte', hidden: true })
    ).toBeTruthy();
    expect(within(statement).getByText('Université Exemple')).toBeTruthy();
    expect(within(statement).getByText('Camille Lavoie')).toBeTruthy();
    expect(within(statement).getByText('Avant le 15 novembre 2026')).toBeTruthy();
    expect(within(statement).getAllByRole('row', { hidden: true })).toHaveLength(5);
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(screen.queryByRole('article', { hidden: true })).toBeNull();
    expect(page.className).not.toMatch(/printing/);
  });

  it('impression pendant le chargement : la page telle quelle, sans relevé', () => {
    renderPage({ status: 'loading' });
    act(() => {
      window.dispatchEvent(new Event('beforeprint'));
    });
    expect(screen.queryByRole('article', { hidden: true })).toBeNull();
  });

  it('rien à enregistrer pendant le chargement ou après une erreur', () => {
    renderPage({ status: 'loading' });
    expect(screen.queryByRole('button', { name: 'Enregistrer en PDF' })).toBeNull();
    cleanup();
    renderPage({ status: 'error' });
    expect(screen.queryByRole('button', { name: 'Enregistrer en PDF' })).toBeNull();
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

  it('liens complémentaires : grisés tant que leur adresse n’est pas fournie', () => {
    renderPage({ status: 'error' });
    const nav = screen.getByRole('navigation', { name: 'Liens complémentaires' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
    const first = within(nav).getByText('Comment payer mes frais de scolarité?').parentElement!;
    expect(first.getAttribute('aria-disabled')).toBe('true');
    expect(first.getAttribute('title')).toBe('Bientôt disponible');
    expect(within(nav).getAllByRole('listitem')).toHaveLength(3);
  });

  it('liens complémentaires : avec une adresse, un lien vers un nouvel onglet', () => {
    render(
      <InvoicesPage
        state={{ status: 'loading' }}
        onRetry={vi.fn()}
        links={[{ label: 'Remboursement', url: 'https://exemple.ca/remboursement' }]}
      />
    );
    const link = screen.getByRole('link', { name: 'Remboursement' });
    expect(link.getAttribute('href')).toBe('https://exemple.ca/remboursement');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('sans lien complémentaire : pas de carte', () => {
    render(<InvoicesPage state={{ status: 'loading' }} onRetry={vi.fn()} links={[]} />);
    expect(screen.queryByRole('navigation', { name: 'Liens complémentaires' })).toBeNull();
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

  it('paiement partiel : le solde restant, ce qui est déjà reçu et chaque paiement', () => {
    renderPage({
      status: 'ready',
      invoice: {
        ...INVOICE,
        payments: [{ date: '2026-10-25', amountCents: 50_000, method: 'Virement bancaire' }],
      },
    });
    // Le solde en haut, puis en bas du détail.
    expect(screen.getAllByText(shown(78_450))).toHaveLength(2);
    expect(screen.getByText(`${shown(50_000)} déjà reçu sur ${shown(128_450)}`)).toBeTruthy();
    expect(screen.getByText('Dans 16 jours')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Comment payer' })).toBeTruthy();
    const rows = within(
      screen.getByRole('table', { name: 'Détail des montants dus' })
    ).getAllByRole('row');
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Droits de scolaritéAutomne 2026, 15 crédits',
      'Frais afférentsServices aux étudiants et technologies',
      'Assurance collective',
      'Total',
      'Paiement reçu25 octobre 2026 · Virement bancaire',
      'Solde à payer',
    ]);
    expect(within(rows[4]).getByRole('cell').textContent).toBe(`−${formatMoney(50_000)}`);
  });

  it('payée : solde nul, pastille « Payée » et date du dernier paiement, sans « Comment payer »', () => {
    renderPage({
      status: 'ready',
      invoice: {
        ...INVOICE,
        payments: [
          { date: '2026-10-18', amountCents: 50_000 },
          { date: '2026-10-28', amountCents: 78_450, method: 'Carte de crédit' },
        ],
      },
    });
    expect(screen.getByText('Payée').className).toMatch(/badgePaid/);
    expect(screen.getByText('Payée en entier le 28 octobre 2026. Merci!')).toBeTruthy();
    expect(screen.queryByText('Échéance le', { exact: false })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment payer' })).toBeNull();
    expect(screen.queryByText('déjà reçu', { exact: false })).toBeNull();
    // Un paiement sans mode : sa date seule.
    expect(screen.getByText('18 octobre 2026')).toBeTruthy();
  });

  it('rien à payer : un solde nul, sans « Comment payer » ni détail', () => {
    renderPage({ status: 'ready', invoice: { session: 'automne 2026', lines: [] } });
    expect(screen.getByText(shown(0))).toBeTruthy();
    expect(screen.getByText('Rien à payer').className).toMatch(/badgePaid/);
    expect(
      screen.getByText("Aucun montant dû pour la session d'automne 2026.", { exact: false })
    ).toBeTruthy();
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
      render(<InvoicesPage state={{ status: 'ready', invoice: INVOICE }} onRetry={vi.fn()} />);
      expect(screen.getByText('Demain')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
