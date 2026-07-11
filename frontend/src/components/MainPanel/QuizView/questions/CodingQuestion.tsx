import React from 'react';
import styles from './questions.module.css';
import { Check } from '../../../../assets/Check';
import { X } from '../../../../assets/X';
import { CodeEditor } from '../../../QuizEditor/CodeEditor';
import { Spinner } from '../../../Spinner/Spinner';
import { type CodingTestResult } from '../quizAttempt';
import { type QuestionViewProps } from './types';
import { defaultQuestionLabels, type QuestionLabels } from './questionLabels';

/**
 * Langages SANS exécution autonome utile → pas de bouton « play » :
 *  - SQL : la requête a besoin des données de test (fournies par le harnais, secret côté étudiant) ;
 *  - HTML / JSX / TSX : ne s'exécutent pas seuls (validés via un harnais JS).
 * Ces langages restent testables via l'onglet « Tester » / la soumission (qui exécute les harnais).
 */
const NO_STANDALONE_RUN = new Set(['sql', 'html', 'jsx', 'tsx']);

/**
 * Question Code : réutilise notre éditeur de code « façon IDE » (`CodeEditor` :
 * gouttière, coloration syntaxique, auto-indentation…), pré-rempli avec `start_code`.
 * La vraie exécution des harnais est SERVEUR ; en révision, l'éditeur passe en lecture
 * seule et `result.tests` liste le verdict par cas (✓/✗) ou `null` si non évalué
 * (mode mock, le code ne tourne pas dans le navigateur).
 */
export function CodingQuestion({
  question,
  mode,
  answer,
  result,
  onChange,
  labels,
  onRunCode,
}: QuestionViewProps): React.ReactElement {
  const t = { ...defaultQuestionLabels, ...labels };
  const code = answer?.kind === 'coding' ? answer.code : question.startCode ?? '';
  const language = question.language?.name;
  const review = mode === 'review';
  // Le « play » n'a de sens que si le langage s'exécute seul (cf. NO_STANDALONE_RUN).
  const runnable = !!language && !NO_STANDALONE_RUN.has(language.toLowerCase());

  return (
    <div>
      {review && <span className={styles.codeLabel}>{t.yourAnswer}</span>}
      {/* Clé = id de la question : au changement de question, l'éditeur est remonté, ce qui
          FERME la console d'exécution (et efface sa sortie) restée ouverte sur la précédente. */}
      <CodeEditor
        key={question.id}
        value={code}
        onChange={(next) => onChange({ kind: 'coding', code: next })}
        language={language}
        readOnly={review}
        minRows={8}
        ariaLabel={t.codeAria(language ?? 'Code')}
        // Bouton « play » : exécute le code courant dans le sandbox (hors révision, langage autonome).
        onRun={onRunCode && !review && runnable ? (src) => onRunCode({ language, code: src }) : undefined}
        runLabel={t.runCode}
      />

      {review && <TestResults tests={result?.tests} labels={t} />}
    </div>
  );
}

/** Verdict des harnais en révision (ou note « évalué côté serveur » si non évalué). */
function TestResults({
  tests,
  labels,
}: {
  tests: CodingTestResult[] | null | undefined;
  labels: QuestionLabels;
}): React.ReactElement {
  if (tests == null) {
    // Pas de verdicts (question Code sans harnais, ou résultat « en cours ») : placeholder.
    // La soumission vérifie désormais le code de façon SYNCHRONE, donc une tentative
    // enregistrée porte normalement déjà ses verdicts.
    return (
      <p className={styles.testNote}>
        <Spinner tone="current" size={14} /> {labels.evaluating}
      </p>
    );
  }
  const totalWeight = tests.reduce((sum, test) => sum + test.weight, 0);

  return (
    <div className={styles.testsBlock}>
      <span className={styles.codeLabel}>{labels.testsResult}</span>
      <div className={styles.tests}>
        {tests.map((t, i) => (
          <div key={i} className={styles.testRow}>
            <span
              className={[
                styles.statusIcon,
                t.passed ? styles.statusOk : styles.statusBad,
                t.passed ? styles.statusIconCircle : styles.statusIconCircleBad,
              ].join(' ')}
            >
              {t.passed ? <Check width={14} height={14} /> : <X width={12} height={12} />}
            </span>
            <span className={styles.testName}>{t.name}</span>
            <span
              className={[styles.testScore, t.passed ? styles.testScorePass : styles.testScoreFail].join(
                ' '
              )}
            >
              {t.passed ? '+' : '−'}
              {t.weight}/{totalWeight}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
