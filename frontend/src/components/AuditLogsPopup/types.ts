/** Une entrée du journal telle que consommée par le popup (miroir du DTO backend). */
export interface AuditLogEntry {
  id: number;
  createdAt: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string;
  /** Contexte parent capturé au moment de l'action (établissement, programmes, cours…). */
  details: string | null;
}

/** Textes affichés par le popup (tous surchargeables). */
export interface AuditLogsPopupLabels {
  title: string;
  subtitle: string;
  close: string;
  loading: string;
  empty: string;
  emptyFiltered: string;
  filterAll: string;
  searchPlaceholder: string;
  searchClear: string;
  loadingMore: string;
  entityIdLabel: string;
  unknownActor: string;
  errorTitle: string;
  loadError: string;
  errorClose: string;
  errorRetry: string;
  /** Libellés lisibles par type d'entité (clé = entityType du backend, en MAJUSCULES). */
  entityTypes: Record<string, string>;
}

/** Critères d'une page (pagination par curseur + recherche/filtre serveur). */
export interface AuditLogQuery {
  beforeId?: number | null;
  q?: string;
  type?: string | null;
  limit?: number;
}
