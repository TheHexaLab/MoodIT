import type {
  InvoiceDraft,
  InvoicePayment,
  InvoiceSummary,
  IssuedInvoice,
} from '../types/domain.ts';

import { sessionName } from '../components/InvoicesPage/invoice.ts';

export { sessionName };

/** Date locale au format AAAA-MM-JJ, `days` jours après `now`. */
function dayAfter(now: Date, days: number): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * État de la facture fictive vue par l'étudiant, pour essayer chaque version de la page :
 * - `due` : à payer (comme dans la maquette) ;
 * - `partial` : un premier versement reçu, le reste à payer ;
 * - `paid` : payée en entier ;
 * - `none` : rien à payer pour la session.
 */
export type DemoInvoiceStatus = 'due' | 'partial' | 'paid' | 'none';

/** Point de bascule de la démo : changer la valeur ici pour voir un autre état de la page. */
export const demoInvoiceStatus: DemoInvoiceStatus = 'due';

/** Lignes de la maquette : droits de scolarité, frais afférents, assurance (1 284,50 $). */
function demoLines(session: string): InvoiceSummary['lines'] {
  const label = session.charAt(0).toUpperCase() + session.slice(1);
  return [
    { label: 'Droits de scolarité', detail: `${label}, 15 crédits`, amountCents: 112_000 },
    {
      label: 'Frais afférents',
      detail: 'Services aux étudiants et technologies',
      amountCents: 13_450,
    },
    { label: 'Assurance collective', detail: label, amountCents: 3_000 },
  ];
}

/**
 * Facture fictive de la session (#207), comme dans les maquettes. Contenu d'exemple, jamais
 * affiché en production. Les dates suivent `now` (échéance dans 16 jours) : la démo reste à jour.
 */
export function demoInvoice(
  now: Date,
  status: DemoInvoiceStatus = demoInvoiceStatus
): InvoiceSummary {
  const session = sessionName(now);
  if (status === 'none') return { session, lines: [] };
  const invoice: InvoiceSummary = {
    session,
    dueDate: dayAfter(now, 16),
    lines: demoLines(session),
  };
  if (status === 'partial') {
    invoice.payments = [
      { date: dayAfter(now, -5), amountCents: 50_000, method: 'Virement bancaire' },
    ];
  } else if (status === 'paid') {
    invoice.payments = [
      { date: dayAfter(now, -12), amountCents: 50_000, method: 'Virement bancaire' },
      { date: dayAfter(now, -2), amountCents: 78_450, method: 'Carte de crédit' },
    ];
  }
  return invoice;
}

// ── Factures émises (vue administration) : en mémoire, le temps de la session du navigateur ──────

let issued: IssuedInvoice[] | null = null;
let nextId = 1;

/** Factures émises fictives : quelques étudiants, dans chaque état. */
function seedIssued(now: Date): IssuedInvoice[] {
  const session = sessionName(now);
  const students: Array<[string, string, number, InvoicePayment[]]> = [
    ['Camille Lavoie', 'camille.lavoie@exemple.ca', 16, []],
    [
      'Jérémie Tremblay',
      'jeremie.tremblay@exemple.ca',
      16,
      [{ date: dayAfter(now, -2), amountCents: 128_450, method: 'Carte de crédit' }],
    ],
    [
      'Amira Benali',
      'amira.benali@exemple.ca',
      16,
      [{ date: dayAfter(now, -5), amountCents: 50_000, method: 'Virement bancaire' }],
    ],
    ['Noah Gagnon', 'noah.gagnon@exemple.ca', -3, []],
    ['Léa Côté', 'lea.cote@exemple.ca', 30, []],
  ];
  return students.map(([studentName, studentEmail, dueIn, payments]) => ({
    id: nextId++,
    session,
    studentName,
    studentEmail,
    dueDate: dayAfter(now, dueIn),
    lines: demoLines(session),
    payments,
  }));
}

/** Copie profonde : l'appelant ne modifie jamais le magasin par mégarde. */
const copy = (invoice: IssuedInvoice): IssuedInvoice => structuredClone(invoice);

/** Factures émises pour la session, les plus récentes d'abord. */
export function demoIssuedInvoices(now: Date): IssuedInvoice[] {
  issued ??= seedIssued(now);
  return issued.map(copy);
}

/** Nouvelle facture émise : elle s'ajoute en tête de la liste. */
export function addDemoInvoice(draft: InvoiceDraft, now: Date): IssuedInvoice {
  issued ??= seedIssued(now);
  const invoice: IssuedInvoice = {
    id: nextId++,
    session: sessionName(now),
    studentName: draft.studentName,
    studentEmail: draft.studentEmail || undefined,
    dueDate: draft.dueDate,
    lines: draft.lines,
    payments: [],
  };
  issued.unshift(invoice);
  return copy(invoice);
}

/** Paiement enregistré par l'administration sur une facture émise. */
export function recordDemoPayment(id: number, payment: InvoicePayment): IssuedInvoice {
  const invoice = issued?.find((candidate) => candidate.id === id);
  if (!invoice) throw new Error('Facture introuvable');
  invoice.payments = [...(invoice.payments ?? []), payment];
  return copy(invoice);
}

/** Tests : repart des factures de départ. */
export function resetDemoIssuedInvoices(): void {
  issued = null;
  nextId = 1;
}
