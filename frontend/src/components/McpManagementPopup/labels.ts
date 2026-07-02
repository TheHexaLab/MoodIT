import type { McpManagementPopupLabels } from './types.ts';

const plural = (n: number) => (n > 1 ? 's' : '');

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: McpManagementPopupLabels = {
  title: 'Gestion MCP',
  subtitle: (courseLabel) => `Feedback · ${courseLabel}`,
  analyzeTitle: 'Analyser mon cours',
  analyzeDescription:
    'Génère une synthèse des points forts et faibles à partir des quiz, des forums et de la participation. À la demande.',
  analyzeButton: 'Analyser',
  historyLabel: 'HISTORIQUE DES ANALYSES',
  noAnalyses: 'Aucune analyse pour ce cours pour l’instant.',
  viewAnalysis: 'Voir l’analyse',
  rowSummary: (strengths, improvements) =>
    `${strengths} force${plural(strengths)} · ${improvements} point${plural(improvements)} à améliorer`,
  loadingHistory: 'Chargement des analyses…',
  loadingDetail: 'Chargement de l’analyse…',
  loadError: 'Échec du chargement des analyses. Réessaie.',
  detailLoadError: 'Échec du chargement de l’analyse. Réessaie.',
  retry: 'Réessayer',
  analyzeError:
    'L’analyse n’a pas pu être générée. Le service d’analyse MCP est momentanément indisponible.',
  // Étapes de progression poussées par le serveur (clé → texte). Clé inconnue → libellé neutre.
  analyzeProgress: (step) =>
    ({
      collecting: 'Collecte des données du cours…',
      analyzing: 'Analyse par l’IA en cours…',
      fallback: 'IA indisponible : analyse de secours…',
    })[step] ?? 'Analyse en cours…',
  errorTitle: 'Une erreur est survenue',
  errorClose: 'Fermer',
  back: 'Retour',
  detailTitle: () => 'Bilan MCP',
  scoreTitle: 'Bilan global du cours',
  detailMeta: (strengths, improvements, quiz, messages) =>
    `${strengths} point${plural(strengths)} fort${plural(strengths)} · ${improvements} à améliorer · basé sur ${quiz} quiz et ${messages} messages`,
  summaryLabel: 'SYNTHÈSE',
  dimensionsLabel: 'RÉPARTITION PAR DIMENSION',
  dimContent: 'Contenu',
  dimEngagement: 'Engagement',
  dimSuccess: 'Réussite',
  dimSentiment: 'Ressenti',
  tabStrengths: 'Points forts',
  tabImprovements: 'À améliorer',
  tabRecommendations: 'Recommandations',
  emptyStrengths: 'Aucun point fort identifié pour ce cours.',
  emptyImprovements: 'Aucun axe d’amélioration identifié.',
  emptyRecommendations: 'Aucune recommandation.',
  generatedNote: (date, author) => `Généré le ${date}${author ? ` par ${author}` : ''}`,
  scopeNote: (quiz, messages, students) =>
    `Sources : ${quiz} quiz, ${messages} messages, ${students} étudiants.`,
};
