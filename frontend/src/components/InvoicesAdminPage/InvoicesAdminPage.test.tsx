import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import InvoicesAdminPage, { type InvoicesAdminApi } from './InvoicesAdminPage';
import { formatMoney } from '../InvoicesPage/invoice';
import type { EnrolledStudent, FeeSchedule } from '../../types/domain';

afterEach(cleanup);

const NOW = new Date(2026, 9, 30);
/** Montant tel que Testing Library le lit : ses espaces insécables deviennent des espaces. */
const shown = (cents: number) => formatMoney(cents).replace(/\s/g, ' ');

const SCHEDULE: FeeSchedule = {
  session: 'automne 2026',
  creditPriceCents: 10_000,
  dueDate: '2026-11-15',
  fees: [
    { label: 'Frais afférents', detail: 'Services aux étudiants', amountCents: 15_000 },
    { label: 'Assurance collective', amountCents: 5_000 },
  ],
};

// Avec 100 $ le crédit et 200 $ de frais communs : 10 crédits → 1 200 $.
const STUDENTS: EnrolledStudent[] = [
  { id: 1, name: 'Camille Lavoie', email: 'camille@exemple.ca', credits: 10, payments: [] },
  {
    id: 2,
    name: 'Jérémie Tremblay',
    credits: 10,
    payments: [{ date: '2026-10-28', amountCents: 120_000 }],
  },
  {
    id: 3,
    name: 'Amira Benali',
    credits: 5,
    payments: [{ date: '2026-10-25', amountCents: 30_000 }],
  },
];

type MockApi = { [K in keyof InvoicesAdminApi]: ReturnType<typeof vi.fn> & InvoicesAdminApi[K] };
let api: MockApi;

beforeEach(() => {
  api = {
    fetchSchedule: vi.fn().mockResolvedValue(structuredClone(SCHEDULE)),
    saveSchedule: vi.fn(async (schedule: FeeSchedule) => schedule),
    fetchStudents: vi.fn().mockResolvedValue(structuredClone(STUDENTS)),
    recordPayment: vi.fn(async (id: number, payment) => ({
      ...STUDENTS.find((student) => student.id === id)!,
      payments: [payment],
    })),
  } as MockApi;
});

const renderPage = (now = NOW) => render(<InvoicesAdminPage api={api} now={now} />);
const ready = () => screen.findByRole('heading', { name: 'Calcul de la facture' });

/** Ligne d'un étudiant (comparée sans expression régulière, comme ailleurs pour CodeQL). */
const row = (name: string) =>
  screen
    .getAllByRole('rowheader')
    .find((header) => header.textContent?.startsWith(name))!
    .closest('tr')!;

const save = () => screen.getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement;

describe('InvoicesAdminPage : le calcul', () => {
  it('crédits × prix du crédit + frais communs = facture, pour 15 crédits par défaut', async () => {
    renderPage();
    await ready();
    expect(screen.getByText("Tarification de la session d'automne 2026")).toBeTruthy();
    expect((screen.getByLabelText("Crédits de l'étudiant") as HTMLInputElement).value).toBe('15');
    expect((screen.getByLabelText('Prix du crédit') as HTMLInputElement).value).toBe('100,00');
    expect(screen.getByText(`= ${shown(150_000)} de droits`)).toBeTruthy();
    // 200 $ de frais communs : dans l'équation, sous la liste, et pour chacun des 3 étudiants.
    expect(screen.getAllByText(shown(20_000))).toHaveLength(5);
    expect(screen.getByText(shown(170_000))).toBeTruthy();
    expect(screen.getByText('Pour 15 crédits')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('le calcul suit la saisie : crédits, prix du crédit et frais', async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByLabelText("Crédits de l'étudiant"), { target: { value: '1' } });
    expect(screen.getByText('Pour 1 crédit')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Prix du crédit'), { target: { value: '80' } });
    expect(screen.getByText(`= ${shown(8_000)} de droits`)).toBeTruthy();
    expect(screen.getByText(shown(28_000))).toBeTruthy();
    // Un montant illisible compte pour 0, le temps de le corriger.
    fireEvent.change(screen.getAllByLabelText('Montant ($)')[1], { target: { value: 'abc' } });
    expect(screen.getByText(shown(23_000))).toBeTruthy();
    // Des crédits illisibles : 0.
    fireEvent.change(screen.getByLabelText("Crédits de l'étudiant"), { target: { value: '' } });
    expect(screen.getByText('Pour 0 crédit')).toBeTruthy();
  });
});

describe('InvoicesAdminPage : les frais communs', () => {
  it('chaque frais se modifie ; un libellé courant s’ajoute d’un clic et quitte les suggestions', async () => {
    renderPage();
    await ready();
    const fees = screen.getByRole('group', { name: 'Frais communs' });
    expect(within(fees).getAllByLabelText('Libellé')).toHaveLength(2);
    // Déjà dans la liste : pas proposé.
    expect(within(fees).queryByRole('button', { name: '+ Frais afférents' })).toBeNull();
    fireEvent.click(within(fees).getByRole('button', { name: '+ Frais technologiques' }));
    const labels = within(fees).getAllByLabelText('Libellé') as HTMLInputElement[];
    expect(labels.map((input) => input.value)).toEqual([
      'Frais afférents',
      'Assurance collective',
      'Frais technologiques',
    ]);
    expect(within(fees).queryByRole('button', { name: '+ Frais technologiques' })).toBeNull();
    expect(screen.getByText('3 frais, voir ci-dessous')).toBeTruthy();
    expect(save().disabled).toBe(false);
  });

  it('retirer tous les frais : la facture se limite aux crédits', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Retirer le frais 1 : Frais afférents' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Retirer le frais 1 : Assurance collective' })
    );
    expect(screen.getByText('Aucun frais commun : la facture se limite aux crédits.')).toBeTruthy();
    expect(screen.getByText('0 frais, voir ci-dessous')).toBeTruthy();
  });

  it('un frais vide ajouté se nomme dans son bouton de retrait par son numéro', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '+ Ajouter un frais' }));
    expect(screen.getByRole('button', { name: 'Retirer le frais 3' })).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Précision (facultatif)')[2], {
      target: { value: 'Par session' },
    });
    expect((screen.getAllByLabelText('Précision (facultatif)')[2] as HTMLInputElement).value).toBe(
      'Par session'
    );
  });
});

describe('InvoicesAdminPage : enregistrer', () => {
  it('enregistre la tarification saisie ; le tableau suit', async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByLabelText('Prix du crédit'), { target: { value: '110,50' } });
    fireEvent.change(screen.getByLabelText('Échéance de paiement'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Ajouter un frais' }));
    const labels = screen.getAllByLabelText('Libellé');
    fireEvent.change(labels[2], { target: { value: ' Frais technologiques ' } });
    fireEvent.change(screen.getAllByLabelText('Montant ($)')[2], { target: { value: '45' } });
    expect(
      screen.getByText(
        'Le tableau suit la tarification enregistrée. Enregistrez pour appliquer vos changements.'
      )
    ).toBeTruthy();
    fireEvent.click(save());

    expect(
      await screen.findByText('Tarification enregistrée. Les factures des étudiants sont à jour.')
    ).toBeTruthy();
    expect(api.saveSchedule).toHaveBeenCalledWith({
      session: 'automne 2026',
      creditPriceCents: 11_050,
      dueDate: '2026-12-01',
      fees: [
        { label: 'Frais afférents', detail: 'Services aux étudiants', amountCents: 15_000 },
        { label: 'Assurance collective', detail: undefined, amountCents: 5_000 },
        { label: 'Frais technologiques', detail: undefined, amountCents: 4_500 },
      ],
    });
    expect(save().disabled).toBe(true);
    // 10 crédits × 110,50 $ + 245 $ de frais communs : total et solde.
    expect(within(row('Camille Lavoie')).getAllByText(shown(135_000))).toHaveLength(2);
  });

  it('erreurs de saisie : prix du crédit, échéance, puis frais incomplet', async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByLabelText('Prix du crédit'), { target: { value: '0' } });
    fireEvent.click(save());
    expect(screen.getByRole('alert').textContent).toBe(
      'Indiquez un prix du crédit plus grand que 0.'
    );
    fireEvent.change(screen.getByLabelText('Prix du crédit'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Échéance de paiement'), { target: { value: '' } });
    fireEvent.click(save());
    expect(screen.getByRole('alert').textContent).toBe("Indiquez l'échéance.");
    fireEvent.change(screen.getByLabelText('Échéance de paiement'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(screen.getAllByLabelText('Libellé')[0], { target: { value: '' } });
    fireEvent.click(save());
    expect(screen.getByRole('alert').textContent).toBe(
      "Chaque frais a besoin d'un libellé et d'un montant plus grand que 0."
    );
    expect(api.saveSchedule).not.toHaveBeenCalled();
  });

  it('enregistrement refusé : un message, les changements restent', async () => {
    api.saveSchedule.mockRejectedValueOnce(new Error('panne'));
    renderPage();
    await ready();
    fireEvent.change(screen.getByLabelText('Prix du crédit'), { target: { value: '90' } });
    fireEvent.click(save());
    expect(
      await screen.findByText("La tarification n'a pas pu être enregistrée. Réessayez.")
    ).toBeTruthy();
    expect((screen.getByLabelText('Prix du crédit') as HTMLInputElement).value).toBe('90');
    expect(save().disabled).toBe(false);
  });

  it('« Annuler les changements » revient à la tarification enregistrée', async () => {
    renderPage();
    await ready();
    expect(screen.queryByRole('button', { name: 'Annuler les changements' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Prix du crédit'), { target: { value: '0' } });
    fireEvent.click(save());
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler les changements' }));
    expect((screen.getByLabelText('Prix du crédit') as HTMLInputElement).value).toBe('100,00');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(save().disabled).toBe(true);
  });
});

describe('InvoicesAdminPage : les étudiants', () => {
  it('totaux et une ligne par étudiant : crédits, droits, frais, total, solde et état', async () => {
    renderPage();
    await ready();
    // Facturé 1 200 + 1 200 + 700 $, reçu 1 200 + 300 $, à recevoir 1 200 + 400 $.
    expect(screen.getByText(shown(310_000))).toBeTruthy();
    expect(screen.getByText('3 étudiants')).toBeTruthy();
    expect(screen.getByText(shown(150_000))).toBeTruthy();
    expect(screen.getByText('48 % du total')).toBeTruthy();
    expect(screen.getByText(shown(160_000))).toBeTruthy();
    expect(screen.getByText('Aucune facture en retard')).toBeTruthy();

    const camille = within(row('Camille Lavoie'));
    expect(camille.getByText('camille@exemple.ca')).toBeTruthy();
    expect(camille.getByText('10')).toBeTruthy();
    expect(camille.getByText(shown(100_000))).toBeTruthy();
    expect(camille.getByText('À payer')).toBeTruthy();
    expect(within(row('Jérémie Tremblay')).getByText('Payée')).toBeTruthy();
    expect(within(row('Jérémie Tremblay')).queryByRole('button')).toBeNull();
    const amira = within(row('Amira Benali'));
    expect(amira.getByText('Paiement partiel')).toBeTruthy();
    // 5 × 100 $ + 200 $ = 700 $, dont 300 $ reçus.
    expect(amira.getByText(shown(40_000))).toBeTruthy();
  });

  it('échéance passée : les factures non payées sont en retard', async () => {
    renderPage(new Date(2026, 10, 20));
    await ready();
    expect(screen.getByText('2 en retard').className).toMatch(/statLate/);
    expect(within(row('Camille Lavoie')).getByText('En retard')).toBeTruthy();
  });

  it('« Marquer payée » enregistre le solde de l’étudiant, à la date du jour', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Marquer payée : Amira Benali' }));
    expect(await screen.findByText('Paiement enregistré pour Amira Benali.')).toBeTruthy();
    expect(api.recordPayment).toHaveBeenCalledWith(3, {
      date: '2026-10-30',
      amountCents: 40_000,
      method: "Enregistré par l'administration",
    });
  });

  it('paiement refusé : un message, l’étudiant reste à payer', async () => {
    api.recordPayment.mockRejectedValueOnce(new Error('panne'));
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Marquer payée : Camille Lavoie' }));
    expect(
      await screen.findByText("Le paiement n'a pas pu être enregistré. Réessayez.")
    ).toBeTruthy();
    expect(within(row('Camille Lavoie')).getByText('À payer')).toBeTruthy();
  });

  it('aucun étudiant inscrit : un message', async () => {
    api.fetchStudents.mockResolvedValue([]);
    renderPage();
    await ready();
    expect(screen.getByText('Aucun étudiant inscrit pour cette session.')).toBeTruthy();
    expect(screen.getByText('0 étudiant')).toBeTruthy();
    expect(screen.getByText('0 % du total')).toBeTruthy();
  });
});

describe('InvoicesAdminPage : chargement', () => {
  it('chargement, puis erreur et « Réessayer »', async () => {
    api.fetchSchedule.mockRejectedValueOnce(new Error('panne'));
    renderPage();
    expect(screen.getByText('Chargement de la facturation…')).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Impossible de charger la facturation.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
    expect(await ready()).toBeTruthy();
    expect(api.fetchSchedule).toHaveBeenCalledTimes(2);
  });

  it('une réponse arrivée après le démontage est ignorée', async () => {
    let resolve: (value: FeeSchedule) => void = () => {};
    api.fetchSchedule.mockReturnValue(new Promise((done) => (resolve = done)));
    const { unmount } = renderPage();
    unmount();
    resolve(SCHEDULE);
    await Promise.resolve();
    expect(screen.queryByRole('heading', { name: 'Calcul de la facture' })).toBeNull();
  });

  it('une erreur arrivée après le démontage est ignorée', async () => {
    let reject: (error: Error) => void = () => {};
    api.fetchSchedule.mockReturnValue(new Promise((_, fail) => (reject = fail)));
    const { unmount } = renderPage();
    unmount();
    reject(new Error('panne'));
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
