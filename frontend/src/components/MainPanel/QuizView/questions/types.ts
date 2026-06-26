import { type Question } from '../../../../types/domain';
import { type QuestionAnswer, type QuestionResult } from '../quizAttempt';

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
}
