import type { AuditLogsPopupLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: AuditLogsPopupLabels = {
  title: "Journal d'audit",
  subtitle: 'Actions de gestion récentes.',
  close: 'Fermer',
  loading: 'Chargement du journal…',
  empty: 'Aucune action enregistrée.',
  emptyFiltered: 'Aucune action ne correspond à ce filtre.',
  filterAll: 'Tout',
  searchPlaceholder: 'Rechercher (résumé, auteur, contexte)…',
  searchClear: 'Effacer la recherche',
  loadingMore: 'Chargement…',
  entityIdLabel: 'Identifiant',
  unknownActor: 'Système',
  errorTitle: 'Une erreur est survenue',
  loadError: 'Échec du chargement du journal. Réessaie.',
  errorClose: 'Fermer',
  errorRetry: 'Réessayer',
  entityTypes: {
    ROLE: 'Rôle',
    ESTABLISHMENT: 'Établissement',
    PROGRAM: 'Programme',
    COURSE: 'Cours',
    FORUM: 'Forum',
    QUIZ: 'Quiz',
    ENROLLMENT: 'Inscription',
    MCP: 'Analyse MCP',
  },
};
