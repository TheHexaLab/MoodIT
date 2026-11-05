import type { InvoiceSummary } from '../types/domain.ts';

/** Session d'une date : hiver (janvier à avril), été (mai à août), automne (septembre à décembre). */
export function sessionName(now: Date): string {
  const month = now.getMonth();
  const season = month < 4 ? 'hiver' : month < 8 ? 'été' : 'automne';
  return `${season} ${now.getFullYear()}`;
}

/** Date locale au format AAAA-MM-JJ. */
function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Factures fictives de la session (#207), comme dans les maquettes. Contenu d'exemple, jamais
 * affiché en production. L'échéance suit `now` (dans 16 jours) : la maquette reste à jour.
 */
export function demoInvoice(now: Date): InvoiceSummary {
  const session = sessionName(now);
  const label = session.charAt(0).toUpperCase() + session.slice(1);
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 16);
  return {
    session,
    dueDate: isoDate(due),
    lines: [
      { label: 'Droits de scolarité', detail: `${label}, 15 crédits`, amountCents: 112_000 },
      {
        label: 'Frais afférents',
        detail: 'Services aux étudiants et technologies',
        amountCents: 13_450,
      },
      { label: 'Assurance collective', detail: label, amountCents: 3_000 },
    ],
  };
}
