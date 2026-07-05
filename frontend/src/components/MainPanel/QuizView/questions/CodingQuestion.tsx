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
}: QuestionViewProps): React.ReactElement {
  const t = { ...defaultQuestionLabels, ...labels };
  const code = answer?.kind === 'coding' ? answer.code : question.startCode ?? '';
  const language = question.language?.name;
  const review = mode === 'review';

  return (
    <div>
      {review && <span className={styles.codeLabel}>{t.yourAnswer}</span>}
      <CodeEditor
        value={code}
        onChange={(next) => onChange({ kind: 'coding', code: next })}
        language={language}
        readOnly={review}
        minRows={8}
        ariaLabel={t.codeAria(language ?? 'Code')}
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
    // Verdicts pas encore reçus : la correction du code tourne en async (sandbox). Le WS
    // `quiz:code-graded` remplacera ce placeholder par les résultats dès qu'ils arrivent.
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
