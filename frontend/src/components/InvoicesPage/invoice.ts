import type {
  FeeSchedule,
  InvoicePayment,
  InvoiceSummary,
  SessionFee,
} from '../../types/domain.ts';

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

/** Nom du statut d'un étudiant ; « Statut inconnu » s'il a été retiré de la tarification. */
export function statusLabel(schedule: Pick<FeeSchedule, 'statuses'>, id: string): string {
  return schedule.statuses.find((status) => status.id === id)?.label ?? 'Statut inconnu';
}

/** Prix du crédit d'un statut, en cents ; 0 pour un statut inconnu. */
export function statusPrice(schedule: Pick<FeeSchedule, 'statuses'>, id: string): number {
  return schedule.statuses.find((status) => status.id === id)?.creditPriceCents ?? 0;
}

/** Droits de scolarité : les crédits × le prix du crédit, en cents. */
export function tuitionCents(credits: number, creditPriceCents: number): number {
  return credits * creditPriceCents;
}

/** « 15 crédits » / « 1 crédit ». */
export function creditsLabel(credits: number): string {
  return `${credits} ${credits > 1 ? 'crédits' : 'crédit'}`;
}

/** Montant d'un frais pour un étudiant : par crédit (× ses crédits) ou fixe pour la session. */
export function feeCents(fee: SessionFee, credits: number): number {
  return fee.basis === 'perCredit' ? fee.amountCents * credits : fee.amountCents;
}

/** Frais qui s'appliquent à un étudiant : tous, sauf les facultatifs dont il s'est retiré. */
export function appliedFees(fees: SessionFee[], optedOut: string[] = []): SessionFee[] {
  return fees.filter((fee) => !(fee.optional && optedOut.includes(fee.label)));
}

/** Total des frais d'un étudiant (hors droits de scolarité), en cents. */
export function feesCents(fees: SessionFee[], credits: number, optedOut: string[] = []): number {
  return appliedFees(fees, optedOut).reduce((sum, fee) => sum + feeCents(fee, credits), 0);
}

/** Ce qu'il faut savoir d'un étudiant pour calculer sa facture. */
export interface BillableStudent {
  credits: number;
  /** Identifiant de son statut. */
  residency: string;
  optedOut?: string[];
}

/**
 * Facture d'un étudiant, calculée à partir de la tarification : une ligne « Droits de scolarité »
 * (crédits × prix du crédit de son statut), puis chaque frais qui s'applique à lui.
 */
export function invoiceFromSchedule(
  schedule: FeeSchedule,
  student: BillableStudent,
  payments: InvoicePayment[] = [],
  /** Aujourd'hui : après l'échéance, des intérêts s'ajoutent sur le solde impayé. */
  now?: Date
): InvoiceSummary {
  const price = statusPrice(schedule, student.residency);
  const invoice: InvoiceSummary = {
    session: schedule.session,
    dueDate: schedule.dueDate,
    lines: [
      {
        label: 'Droits de scolarité',
        detail: `${creditsLabel(student.credits)} × ${formatMoney(price)}`,
        amountCents: tuitionCents(student.credits, price),
      },
      ...appliedFees(schedule.fees, student.optedOut).map((fee) => ({
        label: fee.label,
        detail:
          fee.basis === 'perCredit'
            ? `${creditsLabel(student.credits)} × ${formatMoney(fee.amountCents)}`
            : fee.detail,
        amountCents: feeCents(fee, student.credits),
      })),
    ],
    payments,
  };
  // Intérêts de retard : un pourcentage du solde impayé par mois de retard commencé.
  const rate = schedule.lateInterestPercent ?? 0;
  const months = monthsLate(now ? -daysUntil(schedule.dueDate, now) : 0);
  const unpaid = invoiceTotal(invoice) - invoicePaid(invoice);
  const interest = lateInterestCents(unpaid, rate, months);
  if (interest > 0) {
    invoice.lines.push({
      label: INTEREST_LABEL,
      detail: `${formatPercent(rate)} par mois · ${months} mois de retard`,
      amountCents: interest,
    });
  }
  return invoice;
}

const percent = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 });

/** « 7,5 % ». */
export function formatPercent(rate: number): string {
  return `${percent.format(rate)} %`;
}

/** Mois de retard commencés : 1 du 1er au 30e jour après l'échéance, 2 du 31e au 60e… */
export function monthsLate(daysLate: number): number {
  return daysLate > 0 ? Math.ceil(daysLate / 30) : 0;
}

/**
 * Intérêts sur un solde impayé, en cents : solde × taux mensuel × mois de retard commencés, arrondi
 * au cent. Rien avant l'échéance, ni sur un solde nul.
 */
export function lateInterestCents(
  unpaidCents: number,
  monthlyRatePercent: number,
  months: number
): number {
  if (unpaidCents <= 0 || monthlyRatePercent <= 0 || months <= 0) return 0;
  return Math.round(unpaidCents * (monthlyRatePercent / 100) * months);
}

/** Libellé de la ligne d'intérêts, pour la reconnaître dans une facture. */
export const INTEREST_LABEL = 'Intérêts de retard';

/** Intérêts de retard d'une facture, en cents (0 s'il n'y en a pas). */
export function invoiceInterest(invoice: InvoiceSummary): number {
  return invoice.lines
    .filter((line) => line.label === INTEREST_LABEL)
    .reduce((sum, line) => sum + line.amountCents, 0);
}
