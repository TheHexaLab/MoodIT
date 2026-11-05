import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InvoicesAdminPage, { type InvoicesAdminApi } from './InvoicesAdminPage';
import { formatMoney } from '../InvoicesPage/invoice';
import type { IssuedInvoice } from '../../types/domain';

const NOW = new Date(2026, 9, 30);
const shown = (cents: number) => formatMoney(cents).replace(/\s/g, ' ');

const invoice = (id: number, studentName: string, extra: Partial<IssuedInvoice> = {}) => ({
  id,
  studentName,
  session: 'automne 2026',
  dueDate: '2026-11-15',
  lines: [{ label: 'Droits de scolarité', amountCents: 100_000 }],
  payments: [],
  ...extra,
});

const ISSUED: IssuedInvoice[] = [
  invoice(1, 'Camille Lavoie', { studentEmail: 'camille@exemple.ca' }),
  invoice(2, 'Jérémie Tremblay', { payments: [{ date: '2026-10-28', amountCents: 100_000 }] }),
  invoice(3, 'Amira Benali', { payments: [{ date: '2026-10-25', amountCents: 40_000 }] }),
  invoice(4, 'Noah Gagnon', { dueDate: '2026-10-27' }),
];

let api: { [K in keyof InvoicesAdminApi]: ReturnType<typeof vi.fn> & InvoicesAdminApi[K] };

beforeEach(() => {
  // Animations réduites : la popup se ferme de façon synchrone sous jsdom.
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
  api = {
    fetchIssued: vi.fn().mockResolvedValue(structuredClone(ISSUED)),
    create: vi.fn(async (draft) => ({
      ...draft,
      id: 99,
      session: 'automne 2026',
      payments: [],
    })),
    recordPayment: vi.fn(async (id, payment) => ({
      ...ISSUED.find((other) => other.id === id)!,
      payments: [payment],
    })),
  } as typeof api;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderPage = () => render(<InvoicesAdminPage api={api} session="automne 2026" now={NOW} />);

/** Ligne d'un étudiant (comparée sans expression régulière, comme ailleurs pour CodeQL). */
const row = (name: string) =>
  screen
    .getAllByRole('rowheader')
    .find((header) => header.textContent?.startsWith(name))!
    .closest('tr')!;

describe('InvoicesAdminPage', () => {
  it('totaux de la session : facturé, reçu, à recevoir et retards', async () => {
    renderPage();
    expect(await screen.findByText('Camille Lavoie')).toBeTruthy();
    expect(screen.getByText("Factures émises pour la session d'automne 2026")).toBeTruthy();
    expect(screen.getByText(shown(400_000))).toBeTruthy();
    expect(screen.getByText('4 factures')).toBeTruthy();
    expect(screen.getByText(shown(140_000))).toBeTruthy();
    expect(screen.getByText('35 % du total')).toBeTruthy();
    expect(screen.getByText(shown(260_000))).toBeTruthy();
    expect(screen.getByText('1 en retard').className).toMatch(/statLate/);
  });

  it('une ligne par facture : courriel, échéance, montant, solde et état', async () => {
    renderPage();
    await screen.findByText('Camille Lavoie');
    expect(within(row('Camille Lavoie')).getByText('camille@exemple.ca')).toBeTruthy();
    expect(within(row('Camille Lavoie')).getByText('15 novembre 2026')).toBeTruthy();
    expect(within(row('Camille Lavoie')).getByText('À payer')).toBeTruthy();
    expect(within(row('Jérémie Tremblay')).getByText('Payée')).toBeTruthy();
    expect(within(row('Amira Benali')).getByText('Paiement partiel')).toBeTruthy();
    expect(within(row('Amira Benali')).getByText(shown(60_000))).toBeTruthy();
    expect(within(row('Noah Gagnon')).getByText('En retard')).toBeTruthy();
    // Une facture payée n'a plus de bouton « Marquer payée ».
    expect(within(row('Jérémie Tremblay')).queryByRole('button')).toBeNull();
  });

  it('« Marquer payée » enregistre le solde, à la date du jour', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Marquer payée : Amira Benali' }));
    expect(await screen.findByText('Paiement enregistré pour Amira Benali.')).toBeTruthy();
    expect(api.recordPayment).toHaveBeenCalledWith(3, {
      date: '2026-10-30',
      amountCents: 60_000,
      method: "Enregistré par l'administration",
    });
    expect(within(row('Amira Benali')).getByText('Payée')).toBeTruthy();
  });

  it('paiement refusé : un message, la facture reste à payer', async () => {
    api.recordPayment.mockRejectedValueOnce(new Error('panne'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Marquer payée : Camille Lavoie' }));
    expect(
      await screen.findByText("Le paiement n'a pas pu être enregistré. Réessayez.")
    ).toBeTruthy();
    expect(within(row('Camille Lavoie')).getByText('À payer')).toBeTruthy();
  });

  it('aucune facture : un message, et « Nouvelle facture » reste possible', async () => {
    api.fetchIssued.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Aucune facture émise pour cette session.')).toBeTruthy();
    expect(screen.getByText('0 facture')).toBeTruthy();
    expect(screen.getByText('0 % du total')).toBeTruthy();
    expect(screen.getByText('Aucune facture en retard')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '+ Nouvelle facture' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('chargement, puis erreur et « Réessayer »', async () => {
    api.fetchIssued.mockRejectedValueOnce(new Error('panne'));
    renderPage();
    expect(screen.getByText('Chargement des factures…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '+ Nouvelle facture' }) as HTMLButtonElement).disabled
    ).toBe(true);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Impossible de charger les factures.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('Camille Lavoie')).toBeTruthy();
    expect(api.fetchIssued).toHaveBeenCalledTimes(2);
  });

  it('une réponse arrivée après le démontage est ignorée', async () => {
    let resolve: (value: IssuedInvoice[]) => void = () => {};
    api.fetchIssued.mockReturnValue(new Promise((done) => (resolve = done)));
    const { unmount } = renderPage();
    unmount();
    resolve(ISSUED);
    await Promise.resolve();
    expect(screen.queryByText('Camille Lavoie')).toBeNull();
  });

  it('une erreur arrivée après le démontage est ignorée', async () => {
    let reject: (error: Error) => void = () => {};
    api.fetchIssued.mockReturnValue(new Promise((_, fail) => (reject = fail)));
    const { unmount } = renderPage();
    unmount();
    reject(new Error('panne'));
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Nouvelle facture', () => {
  async function openPopup() {
    renderPage();
    await screen.findByText('Camille Lavoie');
    fireEvent.click(screen.getByRole('button', { name: '+ Nouvelle facture' }));
    return screen.getByRole('dialog', { name: 'Nouvelle facture' });
  }

  it('la session et une échéance dans 30 jours sont proposées', async () => {
    const dialog = await openPopup();
    expect(within(dialog).getByText("Session d'automne 2026")).toBeTruthy();
    expect((within(dialog).getByLabelText('Échéance') as HTMLInputElement).value).toBe(
      '2026-11-29'
    );
  });

  it('émet la facture : elle arrive en tête de la liste, et la fenêtre se ferme', async () => {
    const dialog = await openPopup();
    fireEvent.change(within(dialog).getByLabelText('Étudiant'), {
      target: { value: ' Zoé Martin ' },
    });
    fireEvent.change(within(dialog).getByLabelText('Courriel (facultatif)'), {
      target: { value: 'zoe@exemple.ca' },
    });
    fireEvent.change(within(dialog).getByLabelText('Échéance'), {
      target: { value: '2026-12-01' },
    });
    // Un libellé courant remplit la ligne vide ; le suivant ajoute une ligne.
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Droits de scolarité' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Frais afférents' }));
    const labels = within(dialog).getAllByLabelText('Libellé') as HTMLInputElement[];
    expect(labels.map((input) => input.value)).toEqual(['Droits de scolarité', 'Frais afférents']);
    const amounts = within(dialog).getAllByLabelText('Montant ($)');
    fireEvent.change(amounts[0], { target: { value: '1 120,00' } });
    fireEvent.change(amounts[1], { target: { value: '134.5' } });
    fireEvent.change(within(dialog).getAllByLabelText('Précision (facultatif)')[0], {
      target: { value: '15 crédits' },
    });
    expect(within(dialog).getByText(shown(125_450))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Émettre la facture' }));

    expect(await screen.findByText('Facture émise à Zoé Martin.')).toBeTruthy();
    expect(api.create).toHaveBeenCalledWith({
      studentName: 'Zoé Martin',
      studentEmail: 'zoe@exemple.ca',
      dueDate: '2026-12-01',
      lines: [
        { label: 'Droits de scolarité', detail: '15 crédits', amountCents: 112_000 },
        { label: 'Frais afférents', detail: undefined, amountCents: 13_450 },
      ],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByRole('rowheader')[0].textContent).toBe('Zoé Martin');
  });

  it('erreurs de saisie : nom, échéance, puis lignes incomplètes', async () => {
    const dialog = await openPopup();
    const submit = within(dialog).getByRole('button', { name: 'Émettre la facture' });
    fireEvent.click(submit);
    expect(within(dialog).getByRole('alert').textContent).toBe("Indiquez le nom de l'étudiant.");
    fireEvent.change(within(dialog).getByLabelText('Étudiant'), { target: { value: 'Zoé' } });
    fireEvent.change(within(dialog).getByLabelText('Échéance'), { target: { value: '' } });
    fireEvent.click(submit);
    expect(within(dialog).getByRole('alert').textContent).toBe("Indiquez l'échéance.");
    fireEvent.change(within(dialog).getByLabelText('Échéance'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(within(dialog).getByLabelText('Libellé'), { target: { value: 'Frais' } });
    fireEvent.change(within(dialog).getByLabelText('Montant ($)'), { target: { value: '0' } });
    fireEvent.click(submit);
    expect(within(dialog).getByRole('alert').textContent).toBe(
      "Chaque ligne a besoin d'un libellé et d'un montant plus grand que 0."
    );
    expect(api.create).not.toHaveBeenCalled();
  });

  it('ajouter puis retirer une ligne ; la dernière ne se retire pas', async () => {
    const dialog = await openPopup();
    expect(
      (within(dialog).getByRole('button', { name: 'Retirer la ligne 1' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Ajouter une ligne' }));
    expect(within(dialog).getAllByLabelText('Libellé')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retirer la ligne 2' }));
    expect(within(dialog).getAllByLabelText('Libellé')).toHaveLength(1);
  });

  it('un montant illisible ne compte pas dans le total', async () => {
    const dialog = await openPopup();
    fireEvent.change(within(dialog).getByLabelText('Montant ($)'), { target: { value: 'abc' } });
    expect(within(dialog).getByText(shown(0))).toBeTruthy();
  });

  it('émission refusée : un message, la fenêtre reste ouverte', async () => {
    api.create.mockRejectedValueOnce(new Error('panne'));
    const dialog = await openPopup();
    fireEvent.change(within(dialog).getByLabelText('Étudiant'), { target: { value: 'Zoé' } });
    fireEvent.change(within(dialog).getByLabelText('Libellé'), { target: { value: 'Frais' } });
    fireEvent.change(within(dialog).getByLabelText('Montant ($)'), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Émettre la facture' }));
    expect(
      await within(dialog).findByText("La facture n'a pas pu être émise. Réessayez.")
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Nouvelle facture' })).toBeTruthy();
  });

  it('« Annuler » et le ✕ ferment la fenêtre sans rien émettre', async () => {
    let dialog = await openPopup();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '+ Nouvelle facture' }));
    dialog = screen.getByRole('dialog', { name: 'Nouvelle facture' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.create).not.toHaveBeenCalled();
  });
});
