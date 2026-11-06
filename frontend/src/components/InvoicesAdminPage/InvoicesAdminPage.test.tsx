import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InvoicesAdminPage, { type InvoicesAdminApi } from './InvoicesAdminPage';
import { billingCsv, billingRow, normalizeSearch, stateRank } from './billing';
import { formatMoney } from '../InvoicesPage/invoice';
import type { EnrolledStudent, FeeSchedule } from '../../types/domain';

const NOW = new Date(2026, 9, 30);
/** Montant tel que Testing Library le lit : ses espaces insécables deviennent des espaces. */
const shown = (cents: number) => formatMoney(cents).replace(/\s/g, ' ');

// 100 $ le crédit au Québec ; 10 $ par crédit de frais afférents, 50 $ d'assurance facultative.
const SCHEDULE: FeeSchedule = {
  session: 'automne 2026',
  statuses: [
    { id: 'quebec', label: 'Résident du Québec', creditPriceCents: 10_000 },
    { id: 'canada', label: 'Canadien hors Québec', creditPriceCents: 30_000 },
    { id: 'international', label: 'International', creditPriceCents: 80_000 },
  ],
  dueDate: '2026-11-15',
  fees: [
    { label: 'Frais afférents', amountCents: 1_000, basis: 'perCredit' },
    { label: 'Assurance collective', detail: 'Santé', amountCents: 5_000, optional: true },
  ],
};

// Camille : 10 × 100 + 10 × 10 + 50 = 1 150 $. Jérémie : 1 100 $, payé. Émile : 4 100 $, en partie.
const STUDENTS: EnrolledStudent[] = [
  {
    id: 1,
    name: 'Camille Lavoie',
    email: 'camille@exemple.ca',
    studentNumber: '23000001',
    program: 'Génie logiciel',
    residency: 'quebec',
    credits: 10,
    payments: [],
  },
  {
    id: 2,
    name: 'Jérémie Tremblay',
    residency: 'quebec',
    credits: 10,
    optedOut: ['Assurance collective'],
    payments: [{ date: '2026-10-28', amountCents: 110_000, method: 'Carte de crédit' }],
  },
  {
    id: 3,
    name: 'Émile Benali',
    program: 'Informatique',
    residency: 'international',
    credits: 5,
    payments: [{ date: '2026-10-25', amountCents: 100_000 }],
  },
];

type MockApi = { [K in keyof InvoicesAdminApi]: ReturnType<typeof vi.fn> & InvoicesAdminApi[K] };
let api: MockApi;

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
    fetchSchedule: vi.fn().mockResolvedValue(structuredClone(SCHEDULE)),
    saveSchedule: vi.fn(async (schedule: FeeSchedule) => schedule),
    fetchStudents: vi.fn().mockResolvedValue(structuredClone(STUDENTS)),
  } as MockApi;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderPage = (now = NOW) => render(<InvoicesAdminPage api={api} now={now} />);
const ready = () => screen.findByRole('tab', { name: 'Suivi des étudiants' });
/** Noms des étudiants affichés, dans l'ordre du tableau. */
const names = () =>
  screen.getAllByRole('rowheader').map((header) => within(header).getByRole('button').textContent);
/**
 * Ouvre la liste déroulante `label` (Dropdown : son nom lu est le libellé puis le choix affiché) et
 * y choisit `option`.
 */
const choose = (label: string, option: string) => {
  fireEvent.click(screen.getByRole('button', { name: (name) => name.startsWith(`${label} `) }));
  fireEvent.click(screen.getByRole('button', { name: option }));
};

/** Ligne d'un étudiant (comparée sans expression régulière, comme ailleurs pour CodeQL). */
const row = (name: string) =>
  screen
    .getAllByRole('rowheader')
    .find((header) => header.textContent?.startsWith(name))!
    .closest('tr')!;

describe('billing : calculs du suivi', () => {
  it('état : payée, partiel, à payer, en retard', () => {
    expect(billingRow(SCHEDULE, STUDENTS[1], NOW).state).toBe('paid');
    expect(billingRow(SCHEDULE, STUDENTS[2], NOW).state).toBe('partial');
    expect(billingRow(SCHEDULE, STUDENTS[0], NOW).state).toBe('due');
    expect(billingRow(SCHEDULE, STUDENTS[0], new Date(2026, 10, 20)).state).toBe('late');
    expect(stateRank('late')).toBeLessThan(stateRank('paid'));
    expect(stateRank('none')).toBe(4);
  });

  it('recherche sans accents ni majuscules', () => {
    expect(normalizeSearch('  Émile ')).toBe('emile');
  });

  it('CSV : en-tête, séparateur « ; », montants à virgule, valeurs protégées', () => {
    const rows = [
      billingRow(SCHEDULE, { ...STUDENTS[0], name: 'Lavoie; "Camille"' }, NOW),
      billingRow(SCHEDULE, STUDENTS[1], NOW),
    ];
    const csv = billingCsv(rows, SCHEDULE);
    const lines = csv.slice(1).split('\r\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe('Matricule;Nom;Courriel;Programme;Statut;Crédits;Total;Payé;Solde;État');
    expect(lines[1]).toBe(
      '23000001;"Lavoie; ""Camille""";camille@exemple.ca;Génie logiciel;Résident du Québec;10;1150,00;0,00;1150,00;À payer'
    );
    expect(lines[2]).toBe(';Jérémie Tremblay;;;Résident du Québec;10;1100,00;1100,00;0,00;Payée');
  });
});

describe('InvoicesAdminPage : suivi des étudiants', () => {
  it('indicateurs de la session : facturé, encaissé, à recevoir, échéance', async () => {
    renderPage();
    await ready();
    expect(screen.getByText("Facturation de la session d'automne 2026")).toBeTruthy();
    // 1 150 + 1 100 + 4 100 = 6 350 $ ; reçu 2 100 $.
    expect(screen.getByText(shown(635_000))).toBeTruthy();
    expect(screen.getByText('3 étudiants inscrits')).toBeTruthy();
    expect(screen.getByText(shown(210_000))).toBeTruthy();
    expect(
      screen.getByRole('meter', { name: 'Part encaissée' }).getAttribute('aria-valuenow')
    ).toBe('33');
    expect(screen.getByText('2 soldes ouverts')).toBeTruthy();
    expect(screen.getByText('15 novembre 2026')).toBeTruthy();
    expect(screen.getByText('Dans 16 jours')).toBeTruthy();
  });

  it('par urgence : à payer, puis partiel, puis payée', async () => {
    renderPage();
    await ready();
    expect(names()).toEqual(['Camille Lavoie', 'Émile Benali', 'Jérémie Tremblay']);
    const camille = within(row('Camille Lavoie'));
    expect(camille.getByText('23000001 · Génie logiciel')).toBeTruthy();
    expect(camille.getByText('Résident du Québec')).toBeTruthy();
    expect(camille.getByText('À payer')).toBeTruthy();
    expect(within(row('Émile Benali')).getByText('International')).toBeTruthy();
    expect(within(row('Jérémie Tremblay')).getByText('Payée')).toBeTruthy();
    expect(screen.getByText('3 étudiants')).toBeTruthy();
  });

  it('les filtres par état comptent les étudiants et filtrent le tableau', async () => {
    renderPage();
    await ready();
    const filters = screen.getByRole('group', { name: 'Filtrer par état' });
    const paid = within(filters).getByRole('button', { name: /^Payée/ });
    expect(paid.textContent).toContain('1');
    fireEvent.click(paid);
    expect(paid.getAttribute('aria-pressed')).toBe('true');
    expect(names()).toEqual(['Jérémie Tremblay']);
    expect(screen.getByText('1 sur 3 étudiants')).toBeTruthy();
    fireEvent.click(within(filters).getByRole('button', { name: /^En retard/ }));
    expect(screen.getByText('Aucun étudiant ne correspond à ces filtres.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Effacer les filtres' }));
    expect(names()).toHaveLength(3);
  });

  it('recherche par nom (sans accent) ou matricule ; filtre par statut', async () => {
    renderPage();
    await ready();
    const search = screen.getByRole('searchbox', { name: 'Rechercher un étudiant' });
    fireEvent.change(search, { target: { value: 'emile' } });
    expect(names()).toEqual(['Émile Benali']);
    fireEvent.change(search, { target: { value: '23000001' } });
    expect(names()).toEqual(['Camille Lavoie']);
    fireEvent.change(search, { target: { value: '' } });
    choose('Statut', 'International');
    expect(names()).toEqual(['Émile Benali']);
  });

  it('tri : solde, nom, crédits', async () => {
    renderPage();
    await ready();
    choose('Trier par', 'Solde le plus élevé');
    expect(names()).toEqual(['Émile Benali', 'Camille Lavoie', 'Jérémie Tremblay']);
    choose('Trier par', 'Nom (A à Z)');
    expect(names()).toEqual(['Camille Lavoie', 'Émile Benali', 'Jérémie Tremblay']);
    choose('Trier par', 'Crédits');
    expect(names()[2]).toBe('Émile Benali');
    // Le choix est affiché dans le bouton de la liste.
    expect(screen.getByRole('button', { name: 'Trier par Crédits' })).toBeTruthy();
  });

  it('« Exporter (CSV) » télécharge les lignes affichées', async () => {
    // jsdom n'a pas d'URL d'objet : on les simule le temps du test.
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:factures');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderPage();
      await ready();
      fireEvent.click(screen.getByRole('button', { name: 'Exporter (CSV)' }));
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
        'facturation-automne-2026.csv'
      );
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:factures');
    } finally {
      click.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('échéance passée : la tuile alerte, et les soldes ouverts sont en retard', async () => {
    renderPage(new Date(2026, 10, 20));
    await ready();
    expect(screen.getByText('2 en retard')).toBeTruthy();
    expect(within(row('Camille Lavoie')).getByText('En retard')).toBeTruthy();
  });

  it('aucun étudiant inscrit : un message, sans export', async () => {
    api.fetchStudents.mockResolvedValue([]);
    renderPage();
    await ready();
    expect(screen.getByText('Aucun étudiant inscrit pour cette session.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Exporter (CSV)' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Effacer les filtres' })).toBeNull();
  });
});

describe('InvoicesAdminPage : détail d’un étudiant', () => {
  async function openStudent(name: string) {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name }));
    return screen.getByRole('dialog', { name: `Facture de ${name}` });
  }

  it('la facture ligne par ligne, en consultation seulement', async () => {
    const dialog = await openStudent('Camille Lavoie');
    expect(within(dialog).getByText('23000001 · Génie logiciel · camille@exemple.ca')).toBeTruthy();
    expect(within(dialog).getByText('Résident du Québec')).toBeTruthy();
    expect(within(dialog).getByText('10 crédits')).toBeTruthy();
    expect(within(dialog).getByText('Droits de scolarité')).toBeTruthy();
    expect(within(dialog).getByText('Santé')).toBeTruthy();
    expect(within(dialog).getByText("Aucun paiement reçu pour l'instant.")).toBeTruthy();
    // Pas de saisie de paiement : ni montant, ni date, ni mode.
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).getAllByRole('button')).toHaveLength(1);
  });

  it('facture payée : les paiements reçus et les frais refusés sont nommés', async () => {
    const dialog = await openStudent('Jérémie Tremblay');
    expect(within(dialog).getByText('Payée')).toBeTruthy();
    expect(within(dialog).getByText('A refusé : Assurance collective.')).toBeTruthy();
    expect(within(dialog).getByText('Payée en entier')).toBeTruthy();
    expect(within(dialog).getByText('28 octobre 2026')).toBeTruthy();
    expect(within(dialog).getByText('Carte de crédit')).toBeTruthy();
    expect(within(dialog).queryByText("Aucun paiement reçu pour l'instant.")).toBeNull();
  });

  it('après l’échéance : 2 % par mois du solde impayé', async () => {
    api.fetchSchedule.mockResolvedValue({ ...structuredClone(SCHEDULE), lateInterestPercent: 2 });
    // 10 jours après l'échéance du 15 novembre : un mois commencé. Camille : 2 % de 1 150 $ ;
    // Émile : 2 % de 3 100 $. Soit 23,00 $ + 62,00 $.
    renderPage(new Date(2026, 10, 25));
    await ready();
    expect(screen.getByText(`2 soldes ouverts, dont ${shown(8_500)} d'intérêts`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Camille Lavoie' }));
    const dialog = screen.getByRole('dialog', { name: 'Facture de Camille Lavoie' });
    expect(within(dialog).getByText('Intérêts de retard')).toBeTruthy();
    expect(within(dialog).getByText('2 % par mois · 1 mois de retard')).toBeTruthy();
    expect(within(dialog).getByText(shown(2_300))).toBeTruthy();
    expect(within(dialog).getByText('En retard de 10 jours')).toBeTruthy();
  });

  it('un clic sur la ligne ouvre aussi le détail ; ✕ le ferme', async () => {
    renderPage();
    await ready();
    fireEvent.click(within(row('Émile Benali')).getByText('International'));
    const dialog = screen.getByRole('dialog', { name: 'Facture de Émile Benali' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('InvoicesAdminPage : tarification', () => {
  async function openPricing() {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: 'Tarification' }));
  }

  it('un prix du crédit par statut, et le simulateur qui en découle', async () => {
    await openPricing();
    expect(screen.getByRole('tab', { name: 'Tarification' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(
      (screen.getByLabelText('Prix du crédit : Résident du Québec') as HTMLInputElement).value
    ).toBe('100,00');
    // 15 crédits au Québec : 1 500 + 150 + 50 = 1 700 $.
    expect(screen.getByText(shown(170_000))).toBeTruthy();
    choose('Statut', 'Canadien hors Québec');
    expect(screen.getByText(shown(470_000))).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Avec les frais facultatifs'));
    expect(screen.getByText(shown(465_000))).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Crédits'), { target: { value: '1' } });
    expect(screen.getByText('Total pour 1 crédit')).toBeTruthy();
  });

  it('un statut utilisé ne se retire pas ; un statut sans étudiant, oui', async () => {
    await openPricing();
    // Camille et Jérémie au Québec, Émile à l'international ; personne au Canada.
    expect(
      screen.queryByRole('button', { name: 'Retirer le statut : Résident du Québec' })
    ).toBeNull();
    expect(screen.getAllByText('2 étudiants')).toHaveLength(1);
    expect(screen.getAllByText('Aucun étudiant')).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'Retirer le statut : Canadien hors Québec' })
    );
    expect(screen.queryByLabelText('Prix du crédit : Canadien hors Québec')).toBeNull();
  });

  it('ajouter un statut : il se nomme, a son prix, et le simulateur le propose', async () => {
    await openPricing();
    fireEvent.click(screen.getByRole('button', { name: '+ Ajouter un statut' }));
    expect(screen.getByLabelText('Prix du crédit : statut 4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nom du statut 4'), {
      target: { value: 'Français (entente)' },
    });
    fireEvent.change(screen.getByLabelText('Prix du crédit : Français (entente)'), {
      target: { value: '315' },
    });
    choose('Statut', 'Français (entente)');
    // 15 × 315 + 150 + 50 = 4 925 $.
    expect(screen.getByText(shown(492_500))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la tarification' }));
    await waitFor(() =>
      expect(api.saveSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          statuses: expect.arrayContaining([
            { id: 'statut-100', label: 'Français (entente)', creditPriceCents: 31_500 },
          ]),
        })
      )
    );
  });

  it('statuts : un nom manquant, un nom en double, ou aucun statut', async () => {
    await openPricing();
    const save = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la tarification' }));
    fireEvent.change(screen.getByLabelText('Nom du statut 2'), { target: { value: ' ' } });
    save();
    expect(screen.getByRole('alert').textContent).toBe(
      "Chaque statut a besoin d'un nom et d'un prix du crédit plus grand que 0."
    );
    fireEvent.change(screen.getByLabelText('Nom du statut 2'), {
      target: { value: 'résident du québec' },
    });
    save();
    expect(screen.getByRole('alert').textContent).toBe('Deux statuts portent le même nom.');
    expect(api.saveSchedule).not.toHaveBeenCalled();
  });

  it('sans étudiant inscrit, tous les statuts se retirent ; il en faut au moins un', async () => {
    api.fetchStudents.mockResolvedValue([]);
    await openPricing();
    for (const name of ['Résident du Québec', 'Canadien hors Québec', 'International']) {
      fireEvent.click(screen.getByRole('button', { name: `Retirer le statut : ${name}` }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la tarification' }));
    expect(screen.getByRole('alert').textContent).toBe('Ajoutez au moins un statut.');
  });

  it('modifier un frais : base de calcul, facultatif ; la barre d’enregistrement apparaît', async () => {
    await openPricing();
    expect(screen.queryByRole('region', { name: 'Changements non enregistrés' })).toBeNull();
    const basis = screen.getByRole('radiogroup', { name: 'Base de calcul : Frais afférents' });
    fireEvent.click(within(basis).getByRole('radio', { name: 'Par session' }));
    expect(
      within(basis).getByRole('radio', { name: 'Par session' }).getAttribute('aria-checked')
    ).toBe('true');
    fireEvent.click(screen.getAllByLabelText('Facultatif')[0]);
    expect(screen.getByRole('region', { name: 'Changements non enregistrés' })).toBeTruthy();
  });

  it('ajouter, préciser et retirer des frais ; les frais courants s’ajoutent d’un clic', async () => {
    await openPricing();
    fireEvent.click(screen.getByRole('button', { name: '+ Frais technologiques' }));
    expect(screen.queryByRole('button', { name: '+ Frais technologiques' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Ajouter un frais' }));
    expect(screen.getByRole('button', { name: 'Retirer : frais 4' })).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Précision (facultatif)')[3], {
      target: { value: 'Par session' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retirer : frais 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retirer : Frais afférents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retirer : Assurance collective' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retirer : Frais technologiques' }));
    expect(screen.getByText('Aucun frais : la facture se limite aux crédits.')).toBeTruthy();
  });

  it('enregistre la tarification ; le suivi suit', async () => {
    await openPricing();
    fireEvent.change(screen.getByLabelText('Prix du crédit : Résident du Québec'), {
      target: { value: '110,50' },
    });
    fireEvent.change(screen.getByLabelText('Échéance de paiement'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la tarification' }));
    expect(
      await screen.findByText('Tarification enregistrée. Les factures des étudiants sont à jour.')
    ).toBeTruthy();
    expect(api.saveSchedule).toHaveBeenCalledWith({
      session: 'automne 2026',
      statuses: [
        { id: 'quebec', label: 'Résident du Québec', creditPriceCents: 11_050 },
        { id: 'canada', label: 'Canadien hors Québec', creditPriceCents: 30_000 },
        { id: 'international', label: 'International', creditPriceCents: 80_000 },
      ],
      dueDate: '2026-12-01',
      fees: [
        {
          label: 'Frais afférents',
          detail: undefined,
          amountCents: 1_000,
          basis: 'perCredit',
          optional: undefined,
        },
        {
          label: 'Assurance collective',
          detail: 'Santé',
          amountCents: 5_000,
          basis: 'perSession',
          optional: true,
        },
      ],
    });
    expect(screen.queryByRole('region', { name: 'Changements non enregistrés' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Suivi des étudiants' }));
    expect(screen.getByText('1 décembre 2026')).toBeTruthy();
  });

  it('erreurs : prix du crédit, échéance, frais incomplet ; « Annuler » revient en arrière', async () => {
    await openPricing();
    const save = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la tarification' }));
    fireEvent.change(screen.getByLabelText('Prix du crédit : International'), {
      target: { value: '0' },
    });
    save();
    expect(screen.getByRole('alert').textContent).toBe(
      "Chaque statut a besoin d'un nom et d'un prix du crédit plus grand que 0."
    );
    fireEvent.change(screen.getByLabelText('Prix du crédit : International'), {
      target: { value: '800' },
    });
    fireEvent.change(screen.getByLabelText('Échéance de paiement'), { target: { value: '' } });
    save();
    expect(screen.getByRole('alert').textContent).toBe("Indiquez l'échéance.");
    fireEvent.change(screen.getByLabelText('Échéance de paiement'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(screen.getAllByLabelText('Montant ($)')[0], { target: { value: 'abc' } });
    save();
    expect(screen.getByRole('alert').textContent).toBe(
      "Chaque frais a besoin d'un libellé et d'un montant plus grand que 0."
    );
    expect(api.saveSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(
      (screen.getByLabelText('Prix du crédit : International') as HTMLInputElement).value
    ).toBe('800,00');
    expect(screen.queryByRole('region', { name: 'Changements non enregistrés' })).toBeNull();
  });

  it('intérêts de retard : un taux annuel enregistré, ou une erreur s’il est illisible', async () => {
    await openPricing();
    const rate = screen.getByLabelText('Intérêts de retard');
    expect((rate as HTMLInputElement).value).toBe('');
    fireEvent.change(rate, { target: { value: 'beaucoup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la tarification' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Indiquez un taux d’intérêt entre 0 et 100 % par mois.'
    );
    fireEvent.change(rate, { target: { value: '7,5 %' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la tarification' }));
    await waitFor(() =>
      expect(api.saveSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ lateInterestPercent: 7.5 })
      )
    );
    // Relu : « 7,5 ».
    expect((screen.getByLabelText('Intérêts de retard') as HTMLInputElement).value).toBe('7,5');
  });

  it('enregistrement refusé : un message, les changements restent', async () => {
    api.saveSchedule.mockRejectedValueOnce(new Error('panne'));
    await openPricing();
    fireEvent.change(screen.getByLabelText('Prix du crédit : Canadien hors Québec'), {
      target: { value: '320' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la tarification' }));
    expect(
      await screen.findByText("La tarification n'a pas pu être enregistrée. Réessayez.")
    ).toBeTruthy();
    expect(
      (screen.getByLabelText('Prix du crédit : Canadien hors Québec') as HTMLInputElement).value
    ).toBe('320');
  });

  it('onglets au clavier : flèches, Début et Fin', async () => {
    renderPage();
    const students = await ready();
    fireEvent.keyDown(students, { key: 'ArrowRight' });
    const pricing = screen.getByRole('tab', { name: 'Tarification' });
    expect(pricing.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(pricing);
    fireEvent.keyDown(pricing, { key: 'ArrowRight' });
    expect(students.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(students, { key: 'ArrowLeft' });
    expect(pricing.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(pricing, { key: 'Home' });
    expect(students.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(students, { key: 'End' });
    expect(pricing.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(pricing, { key: 'a' });
    expect(pricing.getAttribute('aria-selected')).toBe('true');
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

  it('une réponse ou une erreur arrivée après le démontage est ignorée', async () => {
    let resolve: (value: FeeSchedule) => void = () => {};
    api.fetchSchedule.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const first = renderPage();
    first.unmount();
    resolve(SCHEDULE);
    await Promise.resolve();
    expect(screen.queryByRole('tab')).toBeNull();

    let reject: (error: Error) => void = () => {};
    api.fetchSchedule.mockReturnValueOnce(new Promise((_, fail) => (reject = fail)));
    const second = renderPage();
    second.unmount();
    reject(new Error('panne'));
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
