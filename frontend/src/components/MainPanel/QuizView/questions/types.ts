import { type Question } from '../../../../types/domain';
import { type QuestionAnswer, type QuestionResult, type RunCodeHandler } from '../quizAttempt';
import { type QuestionLabels } from './questionLabels';

/** Mode d'affichage d'une question : saisie (passation) ou lecture corrigée (révision). */
export type QuestionMode = 'answer' | 'review';

/**
 * Contrat commun des six rendus de question. En mode `answer`, `onChange` remonte
 * la réponse de l'étudiant ; en mode `review`, `result` porte la correction
 * (vérité serveur) et `onChange` est ignoré.
 */
export interface QuestionViewProps {
  question: Question;
  mode: QuestionMode;
  answer: QuestionAnswer | undefined;
  result?: QuestionResult;
  onChange: (answer: QuestionAnswer) => void;
  /** Textes des rendus (surcharge partielle des défauts). */
  labels?: Partial<QuestionLabels>;
  /**
   * Question Code : exécute le code courant dans le sandbox (bouton « play » de l'éditeur). Absent
   * → pas de bouton d'exécution. Ignoré par les autres types de question.
   */
  onRunCode?: RunCodeHandler;
}
