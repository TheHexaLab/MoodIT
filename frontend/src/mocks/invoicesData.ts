import type {
  EnrolledStudent,
  FeeSchedule,
  InvoicePayment,
  InvoiceSummary,
} from '../types/domain.ts';
import {
  invoiceFromSchedule,
  invoiceTotal,
  sessionName,
} from '../components/InvoicesPage/invoice.ts';

export { sessionName };

/** Date locale au format AAAA-MM-JJ, `days` jours après `now`. */
function dayAfter(now: Date, days: number): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ── Tarification de la session (administration) : en mémoire, le temps de la session du navigateur ─

let schedule: FeeSchedule | null = null;

/**
 * Tarification de départ. Montants d'exemple, proches de l'ordre de grandeur québécois (le prix du
 * crédit d'un résident est fixé par le gouvernement), mais pas officiels.
 */
function seedSchedule(now: Date): FeeSchedule {
  return {
    session: sessionName(now),
    statuses: [
      { id: 'quebec', label: 'Résident du Québec', creditPriceCents: 10_500 },
      { id: 'canada', label: 'Canadien hors Québec', creditPriceCents: 31_500 },
      { id: 'france', label: 'Français (entente)', creditPriceCents: 31_500 },
      { id: 'international', label: 'International', creditPriceCents: 85_000 },
    ],
    dueDate: dayAfter(now, 16),
    lateInterestPercent: 2,
    fees: [
      {
        label: 'Frais afférents',
        detail: 'Services aux étudiants',
        amountCents: 900,
        basis: 'perCredit',
      },
      { label: 'Frais technologiques', amountCents: 4_500, basis: 'perSession' },
      {
        label: 'Association étudiante',
        detail: 'Cotisation de la session',
        amountCents: 2_500,
        basis: 'perSession',
        optional: true,
      },
      {
        label: 'Assurance collective',
        detail: 'Santé et dentaire',
        amountCents: 15_000,
        basis: 'perSession',
        optional: true,
      },
    ],
  };
}

/** Tarification de la session (une copie : l'appelant ne modifie pas le magasin par mégarde). */
export function demoFeeSchedule(now: Date): FeeSchedule {
  schedule ??= seedSchedule(now);
  return structuredClone(schedule);
}

/** Nouvelle tarification, enregistrée par l'administration. */
export function saveDemoFeeSchedule(next: FeeSchedule): FeeSchedule {
  schedule = structuredClone(next);
  return structuredClone(schedule);
}

// ── Facture de l'étudiant connecté ─────────────────────────────────────────────────────────────────

/**
 * État de la facture fictive vue par l'étudiant, pour essayer chaque version de la page :
 * - `due` : à payer (comme dans la maquette) ;
 * - `partial` : un premier versement reçu, le reste à payer ;
 * - `paid` : payée en entier ;
 * - `late` : échéance passée depuis 12 jours, avec des intérêts de retard ;
 * - `none` : rien à payer pour la session.
 */
export type DemoInvoiceStatus = 'due' | 'partial' | 'paid' | 'late' | 'none';

/** Point de bascule de la démo : changer la valeur ici pour voir un autre état de la page. */
export const demoInvoiceStatus: DemoInvoiceStatus = 'due';

/** L'étudiant de la démo : résident du Québec, 15 crédits, tous les frais. */
const DEMO_STUDENT = { credits: 15, residency: 'quebec' as const };

/**
 * Facture fictive de la session (#207), calculée à partir de la tarification. Contenu d'exemple,
 * jamais affiché en production. Les dates suivent `now`.
 */
export function demoInvoice(
  now: Date,
  status: DemoInvoiceStatus = demoInvoiceStatus
): InvoiceSummary {
  const current = demoFeeSchedule(now);
  if (status === 'none') return { session: current.session, lines: [] };
  // En retard : l'échéance est passée depuis 12 jours, et des intérêts s'ajoutent.
  const schedule = status === 'late' ? { ...current, dueDate: dayAfter(now, -12) } : current;
  const total = invoiceTotal(invoiceFromSchedule(schedule, DEMO_STUDENT));
  const payments: InvoicePayment[] =
    status === 'partial'
      ? [{ date: dayAfter(now, -5), amountCents: 50_000, method: 'Virement bancaire' }]
      : status === 'paid'
        ? [
            { date: dayAfter(now, -12), amountCents: 50_000, method: 'Virement bancaire' },
            { date: dayAfter(now, -2), amountCents: total - 50_000, method: 'Carte de crédit' },
          ]
        : [];
  const invoice = invoiceFromSchedule(schedule, DEMO_STUDENT, payments, now);
  if (payments.length === 0) invoice.payments = undefined;
  return invoice;
}

// ── Étudiants inscrits (administration) ────────────────────────────────────────────────────────────

let students: EnrolledStudent[] | null = null;

/** Comment un étudiant fictif a payé : rien, une partie (en cents), ou tout. */
type Paid = 'none' | 'full' | number;

type Seed = [
  name: string,
  program: string,
  residency: string,
  credits: number,
  paid: Paid,
  optedOut?: string[],
];

const SEED: Seed[] = [
  ['Camille Lavoie', 'Génie informatique', 'quebec', 15, 'none'],
  ['Jérémie Tremblay', 'Génie logiciel', 'quebec', 12, 'full'],
  ['Amira Benali', 'Informatique', 'international', 12, 600_000],
  ['Noah Gagnon', 'Génie électrique', 'quebec', 9, 'none', ['Assurance collective']],
  ['Léa Côté', 'Mathématiques', 'quebec', 6, 'full'],
  ['Lucas Martin', 'Génie logiciel', 'canada', 15, 250_000],
  ['Inès Haddad', 'Génie informatique', 'international', 15, 'full'],
  ['Thomas Bouchard', 'Informatique', 'quebec', 15, 100_000],
  ['Chloé Pelletier', 'Génie électrique', 'quebec', 12, 'full', ['Association étudiante']],
  ['Mamadou Diallo', 'Génie logiciel', 'international', 9, 'none'],
  ['Émile Fortin', 'Mathématiques', 'quebec', 15, 'none'],
  ['Sofia Rossi', 'Informatique', 'canada', 12, 'full', ['Assurance collective']],
  ['Olivier Roy', 'Génie informatique', 'quebec', 3, 'none'],
  ['Maya Nguyen', 'Génie logiciel', 'quebec', 15, 'full'],
  ['Hugo Lefebvre', 'Génie électrique', 'france', 15, 'none'],
  ['Manon Girard', 'Informatique', 'france', 12, 'full', ['Assurance collective']],
];

const METHODS = ['Virement bancaire', 'Carte de crédit', 'Paiement en ligne'];

/** Étudiants fictifs : statuts, programmes et états de paiement variés. */
function seedStudents(now: Date): EnrolledStudent[] {
  const current = demoFeeSchedule(now);
  return SEED.map(([name, program, residency, credits, paid, optedOut], index) => {
    const id = index + 1;
    const total = invoiceTotal(invoiceFromSchedule(current, { credits, residency, optedOut }));
    const amount = paid === 'none' ? 0 : paid === 'full' ? total : paid;
    const payments: InvoicePayment[] =
      amount > 0
        ? [
            {
              date: dayAfter(now, -((index % 9) + 1)),
              amountCents: amount,
              method: METHODS[index % 3],
            },
          ]
        : [];
    const [first, last] = name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .split(' ');
    return {
      id,
      name,
      email: `${first}.${last}@exemple.ca`,
      studentNumber: String(23_000_000 + id * 7_919).padStart(8, '0'),
      program,
      residency,
      credits,
      optedOut,
      payments,
    };
  });
}

/** Étudiants inscrits à la session. */
export function demoEnrolledStudents(now: Date): EnrolledStudent[] {
  students ??= seedStudents(now);
  return structuredClone(students);
}

/** Tests : repart de la tarification et des étudiants de départ. */
export function resetDemoBilling(): void {
  schedule = null;
  students = null;
}
