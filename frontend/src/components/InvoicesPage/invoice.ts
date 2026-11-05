import type { FeeSchedule, InvoicePayment, InvoiceSummary } from '../../types/domain.ts';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const money = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' });

/** Montant en dollars canadiens, à la québécoise : « 1 284,50 $ ». */
export function formatMoney(cents: number): string {
  return money.format(cents / 100);
}

/** Total de ce qui est dû pour la session, en cents. */
export function invoiceTotal(invoice: InvoiceSummary): number {
  return invoice.lines.reduce((sum, line) => sum + line.amountCents, 0);
}

/** Déjà payé, en cents. */
export function invoicePaid(invoice: InvoiceSummary): number {
  return (invoice.payments ?? []).reduce((sum, payment) => sum + payment.amountCents, 0);
}

/** Ce qui reste à payer, en cents (jamais négatif). */
export function invoiceBalance(invoice: InvoiceSummary): number {
  return Math.max(invoiceTotal(invoice) - invoicePaid(invoice), 0);
}

/** Date du dernier paiement reçu (AAAA-MM-JJ), s'il y en a un. */
export function lastPaymentDate(invoice: InvoiceSummary): string | undefined {
  return (invoice.payments ?? [])
    .map((payment) => payment.date)
    .sort()
    .at(-1);
}

export type InvoiceStatus = 'none' | 'paid' | 'late' | 'due';

/** État d'une facture : rien à payer, payée, en retard (échéance passée), ou à payer. */
export function invoiceStatus(invoice: InvoiceSummary, now: Date): InvoiceStatus {
  if (invoiceTotal(invoice) <= 0) return 'none';
  if (invoiceBalance(invoice) <= 0) return 'paid';
  if (invoice.dueDate && daysUntil(invoice.dueDate, now) < 0) return 'late';
  return 'due';
}

/** Date locale au format AAAA-MM-JJ. */
export function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Date AAAA-MM-JJ lue comme une date locale (et non à minuit UTC, la veille au Québec). */
function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
}

/** « 15 novembre 2026 ». */
export function formatDueDate(day: string): string {
  return formatDay(parseDay(day));
}

/** « 30 octobre 2026 » : le jour d'une date. */
export function formatDay(date: Date): string {
  return new Intl.DateTimeFormat('fr-CA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** Jours de calendrier entre aujourd'hui et l'échéance : 0 le jour même, négatif une fois passée. */
export function daysUntil(day: string, now: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((parseDay(day).getTime() - today.getTime()) / MS_PER_DAY);
}

export interface DueBadge {
  text: string;
  /** `late` : le jour même ou après, en rouge ; sinon, en jaune. */
  tone: 'soon' | 'late';
}

/** Pastille à côté de l'échéance : « Dans 16 jours », « Demain », « Aujourd'hui », « En retard ». */
export function dueBadge(days: number): DueBadge {
  if (days < 0) return { text: 'En retard', tone: 'late' };
  if (days === 0) return { text: "Aujourd'hui", tone: 'late' };
  if (days === 1) return { text: 'Demain', tone: 'soon' };
  return { text: `Dans ${days} jours`, tone: 'soon' };
}

/** Lien vers une page de l'établissement. Sans `url` : affiché grisé, en attendant la source. */
export interface InvoiceLink {
  label: string;
  url?: string;
}

/** Liens sous la facture ; leurs adresses restent à fournir par l'établissement. */
export const INVOICE_LINKS: InvoiceLink[] = [
  { label: 'Comment payer mes frais de scolarité?' },
  { label: 'Quels frais sont inclus dans ma facture?' },
  { label: 'Remboursement ou désistement de frais' },
];

/** « 1 120,50 » ou « 1120.5 » → 112050 cents ; NaN si le montant n'est pas un nombre. */
export function parseAmount(text: string): number {
  const normalized = text.replace(/[\s$]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  return Math.round(Number(normalized) * 100);
}

/** Session d'une date : hiver (janvier à avril), été (mai à août), automne (septembre à décembre). */
export function sessionName(now: Date): string {
  const month = now.getMonth();
  const season = month < 4 ? 'hiver' : month < 8 ? 'été' : 'automne';
  return `${season} ${now.getFullYear()}`;
}

/** Droits de scolarité : les crédits × le prix du crédit, en cents. */
export function tuitionCents(credits: number, creditPriceCents: number): number {
  return credits * creditPriceCents;
}

/** Frais communs de la session, en cents. */
export function sharedFeesCents(schedule: Pick<FeeSchedule, 'fees'>): number {
  return schedule.fees.reduce((sum, fee) => sum + fee.amountCents, 0);
}

/**
 * Facture d'un étudiant, calculée à partir de la tarification : une ligne « Droits de scolarité »
 * (crédits × prix du crédit), puis chaque frais commun.
 */
export function invoiceFromSchedule(
  schedule: FeeSchedule,
  credits: number,
  payments: InvoicePayment[] = []
): InvoiceSummary {
  return {
    session: schedule.session,
    dueDate: schedule.dueDate,
    lines: [
      {
        label: 'Droits de scolarité',
        detail: `${credits} ${credits > 1 ? 'crédits' : 'crédit'} × ${formatMoney(schedule.creditPriceCents)}`,
        amountCents: tuitionCents(credits, schedule.creditPriceCents),
      },
      ...schedule.fees,
    ],
    payments,
  };
}
