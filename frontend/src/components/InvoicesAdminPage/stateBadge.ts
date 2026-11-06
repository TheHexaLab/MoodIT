import styles from './InvoicesAdminPage.module.css';
import type { PaymentState } from './billing.ts';

/** Classe de la pastille (et du point de légende) d'un état de paiement. */
export const STATE_BADGE: Record<PaymentState, string> = {
  late: styles.badgeLate,
  due: styles.badgeDue,
  partial: styles.badgePartial,
  paid: styles.badgePaid,
  none: styles.badgeNeutral,
};
