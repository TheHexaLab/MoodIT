import React, { useEffect, useMemo, useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter, Portal } from './EditorShell';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup';
import { draftToQuestion, type QuestionDraft } from './editorTypes';
import { QuestionCard } from '../MainPanel/QuizView/QuestionCard';
import { QuestionRenderer } from '../MainPanel/QuizView/questions/QuestionRenderer';
import { gradeQuestion } from '../MainPanel/QuizView/grading';
import { Spinner } from '../Spinner/Spinner';
import {
  emptyAnswer,
  type CodeEvaluationInput,
  type CodingTestResult,
  type QuestionAnswer,
  type QuestionResult,
  type RunCodeHandler,
} from '../MainPanel/QuizView/quizAttempt';
import { type Language } from '../../types/domain';
import { defaultQuestionTestLabels, type QuestionTestLabels } from './questionTestLabels';

interface QuestionTestBodyProps {
  /** Brouillon courant de la question (édits en cours), à prévisualiser. */
  draft: QuestionDraft;
  /** Langages disponibles (pour résoudre le langage d'une question Code). */
  languages?: Language[];
  /** Demande le chargement (paresseux) des langages — si la question est du Code. */
  onRequestLanguages?: () => void;
  /** Évalue une question Code via l'API (exécution serveur des harnais). */
  onEvaluateCode?: (input: CodeEvaluationInput) => Promise<CodingTestResult[]> | CodingTestResult[];
  /** Exécute le code courant sans harnais (bouton « play » de l'éditeur). */
  onRunCode?: RunCodeHandler;
  /** Textes (surcharge partielle des défauts). */
  labels?: Partial<QuestionTestLabels>;
}

/** Construit le résultat d'une question Code à partir des verdicts par harnais. */
function codingResult(
  question: { id: number; totalScore: number },
  tests: CodingTestResult[]
): QuestionResult {
  const totalWeight = tests.reduce((sum, t) => sum + t.weight, 0);
  const passedWeight = tests.reduce((sum, t) => sum + (t.passed ? t.weight : 0), 0);
  // Score au dixième près (format X.X), comme le backend.
  const earned =
    totalWeight === 0 ? 0 : Math.round((question.totalScore * passedWeight) / totalWeight * 10) / 10;
  return { questionId: question.id, earned, max: question.totalScore, tests };
}

/**
 * Page « Tester » : rend la question (brouillon courant) EXACTEMENT comme la verrait
 * un étudiant — mêmes composants (`QuestionCard` + `QuestionRenderer`). L'enseignant
 * répond puis « Corrige ».
 *
 * Correction : types « à réponses » → prévisualisation locale (`gradeQuestion`) ;
 * type **Code** → requête API (`onEvaluateCode`) qui EXÉCUTE les harnais contre le code
 * et renvoie le verdict par test. Aucune persistance : bac à sable isolé du brouillon.
 */
export function QuestionTestBody({
  draft,
  languages,
  onRequestLanguages,
  onEvaluateCode,
  onRunCode,
  labels,
}: QuestionTestBodyProps): React.ReactElement {
  const t = { ...defaultQuestionTestLabels, ...labels };
  // Question dérivée du brouillon (ids temporaires : on ne persiste rien ici).
  const question = useMemo(
    () => draftToQuestion(draft, draft.id ?? -1, languages),
    [draft, languages]
  );

  // Question Code → on s'assure que les langages sont chargés (coloration + éval).
  useEffect(() => {
    if (question.qType === 'coding') onRequestLanguages?.();
  }, [question.qType, onRequestLanguages]);

  const [answer, setAnswer] = useState<QuestionAnswer>(() => emptyAnswer(question));
  const [result, setResult] = useState<QuestionResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewing = result !== null;

  const isCoding = question.qType === 'coding';

  async function correct() {
    setError(null);
    // Question Code : on délègue au backend (exécution des harnais contre le code).
    if (isCoding && onEvaluateCode) {
      setEvaluating(true);
      try {
        const tests = await onEvaluateCode({
          language: question.language?.name,
          languageId: question.language?.id,
          code: answer.kind === 'coding' ? answer.code : '',
          testCases: question.testCases ?? [],
        });
        setResult(codingResult(question, tests));
      } catch {
        setError(t.evalError);
      } finally {
        setEvaluating(false);
      }
      return;
    }
    // Autres types : correction de prévisualisation locale.
    setResult(gradeQuestion(question, answer));
  }

  function reset() {
    setAnswer(emptyAnswer(question));
    setResult(null);
    setError(null);
  }

  return (
    <>
      {/* `testArea` force box-sizing: border-box sur tout le sous-arbre : les composants
          étudiant (width:100% + padding) ne débordent donc pas dans le popup étroit. */}
      <div className={styles.testArea}>
        <div className={styles.infoBanner}>{t.infoBanner}</div>

        <QuestionCard question={question} index={0} result={result ?? undefined} bare>
          <QuestionRenderer
            question={question}
            mode={reviewing ? 'review' : 'answer'}
            answer={answer}
            result={result ?? undefined}
            onChange={setAnswer}
            onRunCode={onRunCode}
          />
        </QuestionCard>
      </div>

      <EditorFooter>
        <div className={styles.footer}>
          <span className={styles.footerSpacer} />
          {reviewing ? (
            <button type="button" className={styles.primaryButton} onClick={reset}>
              {t.retry}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={evaluating}
              onClick={correct}
            >
              {evaluating ? <Spinner tone="current" size={16} /> : t.correct}
            </button>
          )}
        </div>
      </EditorFooter>

      {/* Échec d'évaluation du code : popup d'erreur (au-dessus du popup d'édition),
          avec « Réessayer » qui relance la correction. */}
      {error && (
        <Portal>
          <ErrorPopup
            content={error}
            onClose={() => setError(null)}
            onRetry={() => {
              setError(null);
              void correct();
            }}
          />
        </Portal>
      )}
    </>
  );
}
