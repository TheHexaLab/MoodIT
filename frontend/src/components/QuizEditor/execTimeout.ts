/**
 * Temps limite d'exécution d'une question, en SECONDES : entier de 1 à 60 — mêmes bornes que
 * l'éditeur, `QuizService.normalizeExecTimeout` et `RunnerExec.MAX_RUN_TIMEOUT_MS`.
 *
 * Dans son propre fichier : exporter une fonction depuis un module de composant casse le
 * rafraîchissement à chaud (règle `react-refresh/only-export-components`).
 */
export function clampTimeoutSeconds(seconds: number): number {
  return Math.min(60, Math.max(1, Math.round(seconds)));
}
