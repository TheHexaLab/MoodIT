/** Types et libellés du McpManagementPopup (gestion du feedback MCP d'un cours). */
import type { McpResponse, McpResponseSummary } from '../../types/domain.ts';

/** Valeur synchrone ou asynchrone : les callbacks peuvent retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

// Ré-exportés pour les consommateurs.
export type { McpResponse, McpResponseSummary };

/** Handlers temps réel d'un cours (façade ws.mcp). */
export interface IncomingMcpHandlers {
  /** Une analyse vient d'être créée pour ce cours (push serveur en fin de job réussi). */
  onAnalysisCreated: (analysis: McpResponseSummary) => void;
  /**
   * Un job d'analyse a ÉCHOUÉ. `userId` = le lanceur ; le consommateur ne réagit que si
   * c'est l'utilisateur courant (le verrou est par (cours, user)). `reason` optionnel.
   */
  onAnalysisFailed?: (userId: number, reason?: string) => void;
  /**
   * ÉTAPE de progression d'un job en cours (collecte / analyse IA / repli…). `userId` = le
   * lanceur ; le consommateur ne réagit que si c'est l'utilisateur courant. `step` = clé
   * d'étape, mappée en libellé par le composant.
   */
  onAnalysisProgress?: (userId: number, step: string) => void;
  /**
   * Appelé après une RECONNEXION du WebSocket (pas au 1er connect) : des événements ont
   * pu être manqués pendant la coupure → le consommateur doit se resynchroniser (refetch).
   */
  onResync?: () => void;
}

/** Façade WebSocket des analyses MCP (alignée sur les autres façades de l'appSocket). */
export interface McpSocket {
  /** S'abonne aux analyses d'un cours ; renvoie la fonction de désabonnement. */
  subscribe: (courseId: number, handlers: IncomingMcpHandlers) => () => void;
}

/** Tous les textes affichés par le composant (surcharge via la prop `labels`). */
export interface McpManagementPopupLabels {
  /** Titre de la modale (vue liste). */
  title: string;
  /** Sous-titre (reçoit le libellé du cours). */
  subtitle: (courseLabel: string) => string;
  /** Titre de l'encart d'action. */
  analyzeTitle: string;
  /** Description de l'encart d'action. */
  analyzeDescription: string;
  /** Bouton de déclenchement de l'analyse. */
  analyzeButton: string;
  /** Libellé de la section historique. */
  historyLabel: string;
  /** Message quand il n'y a aucune analyse. */
  noAnalyses: string;
  /** Lien « voir l'analyse » d'une ligne d'historique. */
  viewAnalysis: string;
  /** Résumé d'une ligne d'historique (nb de forces / points à améliorer). */
  rowSummary: (strengths: number, improvements: number) => string;
  /** Texte affiché pendant le chargement de l'historique. */
  loadingHistory: string;
  /** Texte affiché pendant le chargement du détail d'une analyse. */
  loadingDetail: string;
  /** Message d'erreur de chargement de l'historique. */
  loadError: string;
  /** Message d'erreur de chargement du détail d'une analyse. */
  detailLoadError: string;
  /** Bouton « réessayer » de l'état d'erreur. */
  retry: string;
  /** Message d'erreur quand l'analyse échoue. */
  analyzeError: string;
  /** Libellé de l'étape de progression affichée pendant l'analyse (reçoit la clé d'étape). */
  analyzeProgress: (step: string) => string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
  /** Bouton « retour » (vue détail → liste). */
  back: string;
  /** Titre de la vue détail (reçoit la date-heure de l'analyse). */
  detailTitle: (dateTime: string) => string;
  /** Titre du bloc score. */
  scoreTitle: string;
  /** Méta sous le score (forces / à améliorer / sources). */
  detailMeta: (strengths: number, improvements: number, quiz: number, messages: number) => string;
  /** Libellé de section de la synthèse narrative. */
  summaryLabel: string;
  /** Libellé de section des sous-scores par dimension. */
  dimensionsLabel: string;
  /** Libellés des 4 dimensions (content / engagement / success / sentiment). */
  dimContent: string;
  dimEngagement: string;
  dimSuccess: string;
  dimSentiment: string;
  /** Onglet « points forts ». */
  tabStrengths: string;
  /** Onglet « à améliorer ». */
  tabImprovements: string;
  /** Onglet « recommandations ». */
  tabRecommendations: string;
  /** Messages affichés quand l'onglet sélectionné du détail est vide. */
  emptyStrengths: string;
  emptyImprovements: string;
  emptyRecommendations: string;
  /** Note de bas, 1re ligne : date + auteur. `author` vide = mention « par … » omise. */
  generatedNote: (date: string, author: string) => string;
  /** Note de bas, 2e ligne : portée de l'analyse (sources). */
  scopeNote: (quiz: number, messages: number, students: number) => string;
}
