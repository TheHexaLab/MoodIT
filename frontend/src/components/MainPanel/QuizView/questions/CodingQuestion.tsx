import React from 'react';
import styles from './questions.module.css';
import { Check } from '../../../../assets/Check';
import { X } from '../../../../assets/X';
import { type CodingTestResult } from '../quizAttempt';
import { type QuestionViewProps } from './types';

/**
 * Question Code : éditeur simple (gouttière de numéros + zone d'édition monospace)
 * pré-rempli avec `start_code`. La vraie exécution des harnais est SERVEUR ; en
 * révision, `result.tests` liste le verdict par cas (✓/✗) ou `null` si non évalué
 * (cas du mode mock, le code ne tourne pas dans le navigateur).
 */
export function CodingQuestion({
  question,
  mode,
  answer,
  result,
  onChange,
}: QuestionViewProps): React.ReactElement {
  const code = answer?.kind === 'coding' ? answer.code : question.startCode ?? '';
  const language = question.language?.name ?? 'Code';
  const lineCount = Math.max(code.split('\n').length, 1);
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  const review = mode === 'review';

  return (
    <div>
      {review && <span className={styles.codeLabel}>Ta réponse</span>}
      <div className={styles.codePanel}>
        <div className={styles.codeHeader}>
          <span>{language}</span>
          {review && <span className={styles.codeHeaderMuted}>Lecture seule</span>}
        </div>
        <div className={styles.codeBody}>
          <div className={styles.codeGutter} aria-hidden>
            {gutter}
          </div>
          {review ? (
            <pre className={styles.codeReadonly}>{code}</pre>
          ) : (
            <textarea
              className={styles.codeEditor}
              value={code}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              aria-label={`Éditeur de code (${language})`}
              onChange={(e) => onChange({ kind: 'coding', code: e.target.value })}
            />
          )}
        </div>
      </div>

      {review && <TestResults tests={result?.tests} />}
    </div>
  );
}

/** Verdict des harnais en révision (ou note « évalué côté serveur » si non évalué). */
function TestResults({
  tests,
}: {
  tests: CodingTestResult[] | null | undefined;
}): React.ReactElement {
  if (tests == null) {
    return (
      <p className={styles.testNote}>
        Les harnais de test sont exécutés côté serveur ; le détail n'est pas disponible ici.
      </p>
    );
  }
  const totalWeight = tests.reduce((sum, t) => sum + t.weight, 0);

  return (
    <div className={styles.testsBlock}>
      <span className={styles.codeLabel}>Résultat des tests</span>
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
