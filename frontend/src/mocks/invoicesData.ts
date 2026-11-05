import type {
  EnrolledStudent,
  FeeSchedule,
  InvoicePayment,
  InvoiceSummary,
} from '../types/domain.ts';
import { invoiceFromSchedule, sessionName } from '../components/InvoicesPage/invoice.ts';

export { sessionName };

/** Date locale au format AAAA-MM-JJ, `days` jours après `now`. */
function dayAfter(now: Date, days: number): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ── Tarification de la session (administration) : en mémoire, le temps de la session du navigateur ─

let schedule: FeeSchedule | null = null;

/** Tarification de départ : 75 $ le crédit, frais afférents et assurance, échéance dans 16 jours. */
function seedSchedule(now: Date): FeeSchedule {
  return {
    session: sessionName(now),
    creditPriceCents: 7_500,
    dueDate: dayAfter(now, 16),
    fees: [
      {
        label: 'Frais afférents',
        detail: 'Services aux étudiants et technologies',
        amountCents: 13_450,
      },
      { label: 'Assurance collective', amountCents: 3_000 },
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
 * - `none` : rien à payer pour la session.
 */
export type DemoInvoiceStatus = 'due' | 'partial' | 'paid' | 'none';

/** Point de bascule de la démo : changer la valeur ici pour voir un autre état de la page. */
export const demoInvoiceStatus: DemoInvoiceStatus = 'due';

/** Crédits de l'étudiant de la démo. */
const DEMO_CREDITS = 15;

/**
 * Facture fictive de la session (#207) : 15 crédits au prix de la tarification, plus les frais
 * communs. Contenu d'exemple, jamais affiché en production. Les dates suivent `now`.
 */
export function demoInvoice(
  now: Date,
  status: DemoInvoiceStatus = demoInvoiceStatus
): InvoiceSummary {
  const current = demoFeeSchedule(now);
  if (status === 'none') return { session: current.session, lines: [] };
  const invoice = invoiceFromSchedule(current, DEMO_CREDITS);
  const total = invoice.lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (status === 'partial') {
    invoice.payments = [
      { date: dayAfter(now, -5), amountCents: 50_000, method: 'Virement bancaire' },
    ];
  } else if (status === 'paid') {
    invoice.payments = [
      { date: dayAfter(now, -12), amountCents: 50_000, method: 'Virement bancaire' },
      { date: dayAfter(now, -2), amountCents: total - 50_000, method: 'Carte de crédit' },
    ];
  } else {
    invoice.payments = undefined;
  }
  return invoice;
}

// ── Étudiants inscrits (administration) ────────────────────────────────────────────────────────────

let students: EnrolledStudent[] | null = null;

/** Étudiants fictifs : temps plein et partiel, payés, en partie, ou pas encore. */
function seedStudents(now: Date): EnrolledStudent[] {
  const fullyPaid = (credits: number): InvoicePayment[] => {
    const current = demoFeeSchedule(now);
    const total = invoiceFromSchedule(current, credits).lines.reduce(
      (sum, line) => sum + line.amountCents,
      0
    );
    return [{ date: dayAfter(now, -2), amountCents: total, method: 'Carte de crédit' }];
  };
  return [
    {
      id: 1,
      name: 'Camille Lavoie',
      email: 'camille.lavoie@exemple.ca',
      credits: 15,
      payments: [],
    },
    {
      id: 2,
      name: 'Jérémie Tremblay',
      email: 'jeremie.tremblay@exemple.ca',
      credits: 12,
      payments: fullyPaid(12),
    },
    {
      id: 3,
      name: 'Amira Benali',
      email: 'amira.benali@exemple.ca',
      credits: 15,
      payments: [{ date: dayAfter(now, -5), amountCents: 50_000, method: 'Virement bancaire' }],
    },
    { id: 4, name: 'Noah Gagnon', email: 'noah.gagnon@exemple.ca', credits: 9, payments: [] },
    { id: 5, name: 'Léa Côté', email: 'lea.cote@exemple.ca', credits: 6, payments: [] },
  ];
}

/** Étudiants inscrits à la session. */
export function demoEnrolledStudents(now: Date): EnrolledStudent[] {
  students ??= seedStudents(now);
  return structuredClone(students);
}

/** Paiement reçu d'un étudiant, enregistré par l'administration. */
export function recordDemoStudentPayment(id: number, payment: InvoicePayment): EnrolledStudent {
  const student = students?.find((candidate) => candidate.id === id);
  if (!student) throw new Error('Étudiant introuvable');
  student.payments = [...student.payments, payment];
  return structuredClone(student);
}

/** Tests : repart de la tarification et des étudiants de départ. */
export function resetDemoBilling(): void {
  schedule = null;
  students = null;
}
