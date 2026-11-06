import type { EnrolledStudent, FeeSchedule, InvoiceSummary } from '../../types/domain.ts';
import {
  invoiceBalance,
  invoiceFromSchedule,
  invoicePaid,
  invoiceStatus,
  invoiceTotal,
  statusLabel,
} from '../InvoicesPage/invoice.ts';

/** État de paiement d'un étudiant, vu par l'administration. */
export type PaymentState = 'paid' | 'partial' | 'due' | 'late' | 'none';

/** Libellé et ordre d'affichage de chaque état (les plus urgents d'abord). */
export const PAYMENT_STATES: { state: PaymentState; label: string }[] = [
  { state: 'late', label: 'En retard' },
  { state: 'due', label: 'À payer' },
  { state: 'partial', label: 'Paiement partiel' },
  { state: 'paid', label: 'Payée' },
];

export const PAYMENT_LABELS: Record<PaymentState, string> = {
  late: 'En retard',
  due: 'À payer',
  partial: 'Paiement partiel',
  paid: 'Payée',
  none: 'Rien à payer',
};

/** Une ligne du suivi : l'étudiant, sa facture calculée et où il en est. */
export interface BillingRow {
  student: EnrolledStudent;
  invoice: InvoiceSummary;
  total: number;
  paid: number;
  balance: number;
  state: PaymentState;
}

/** Facture et état de paiement d'un étudiant, selon la tarification. */
export function billingRow(schedule: FeeSchedule, student: EnrolledStudent, now: Date): BillingRow {
  const invoice = invoiceFromSchedule(schedule, student, student.payments, now);
  const paid = invoicePaid(invoice);
  const status = invoiceStatus(invoice, now);
  const state: PaymentState =
    status === 'late' ? 'late' : status === 'due' && paid > 0 ? 'partial' : status;
  return {
    student,
    invoice,
    total: invoiceTotal(invoice),
    paid,
    balance: invoiceBalance(invoice),
    state,
  };
}

/** Rang d'urgence d'un état, pour le tri : en retard, à payer, partiel, payée. */
export function stateRank(state: PaymentState): number {
  const index = PAYMENT_STATES.findIndex((entry) => entry.state === state);
  return index < 0 ? PAYMENT_STATES.length : index;
}

/** Recherche sans accents ni majuscules : « emile » trouve « Émile ». */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Valeur CSV : entre guillemets si elle contient un séparateur, un guillemet ou un saut de ligne. */
function csvCell(value: string | number): string {
  const text = String(value);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** « 1234,50 » : un montant pour un tableur réglé en français. */
function csvMoney(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * Suivi au format CSV, séparé par des points-virgules (Excel en français), précédé d'un BOM pour
 * que les accents s'ouvrent correctement.
 */
export function billingCsv(rows: BillingRow[], schedule: Pick<FeeSchedule, 'statuses'>): string {
  const header = [
    'Matricule',
    'Nom',
    'Courriel',
    'Programme',
    'Statut',
    'Crédits',
    'Total',
    'Payé',
    'Solde',
    'État',
  ];
  const lines = rows.map((row) =>
    [
      row.student.studentNumber ?? '',
      row.student.name,
      row.student.email ?? '',
      row.student.program ?? '',
      statusLabel(schedule, row.student.residency),
      row.student.credits,
      csvMoney(row.total),
      csvMoney(row.paid),
      csvMoney(row.balance),
      PAYMENT_LABELS[row.state],
    ]
      .map(csvCell)
      .join(';')
  );
  return '﻿' + [header.join(';'), ...lines].join('\r\n');
}
