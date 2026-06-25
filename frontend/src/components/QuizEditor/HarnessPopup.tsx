import React, { useEffect, useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter } from './EditorShell';
import { CodeEditor } from './CodeEditor';
import { TrashCan } from '../../assets/TrashCan';
import { type TestCaseDraft } from './editorTypes';

interface HarnessBodyProps {
  /** Harnais courants (édités en place ; renvoyés par `onSave`). */
  testCases: TestCaseDraft[];
  /**
   * Langage des harnais (nom) pour la coloration syntaxique. Déterminé par le
   * langage de la question (via Language.harness_language_id), pas par harnais.
   */
  language?: string;
  /** Demande le chargement (paresseux) des langages — le harnais est du Code. */
  onRequestLanguages?: () => void;
  /** Annule (« Annuler » / chevron retour) : retour à la question, sans appliquer. */
  onCancel: () => void;
  /** Valide les harnais édités (le parent les réinjecte dans le brouillon de question). */
  onSave: (testCases: TestCaseDraft[]) => void;
}

const DEFAULT_HARNESS = 'def test():\n    return False\n';

/**
 * Corps « Harnais de test » : édition des harnais cachés d'une question Code.
 * Chaque harnais = nom (retour à l'étudiant) + poids (crédit partiel) + code qui
 * renvoie vrai/faux. Le langage des harnais est celui configuré pour le langage de
 * la question (Language.harness_language_id) — voir [[quiz-subsystem]]. Rendu dans la
 * coquille commune (`EditorShell`) par `QuizEditor` : page empilée, pas un nouveau popup.
 */
export function HarnessBody({
  testCases,
  language,
  onRequestLanguages,
  onCancel,
  onSave,
}: HarnessBodyProps): React.ReactElement {
  const [cases, setCases] = useState<TestCaseDraft[]>(() =>
    testCases.length > 0
      ? testCases.map((t) => ({ ...t }))
      : [{ name: '', harnessCode: DEFAULT_HARNESS, weight: 1 }]
  );

  // Page harnais = contexte Code → on s'assure que les langages sont chargés.
  useEffect(() => {
    onRequestLanguages?.();
  }, [onRequestLanguages]);

  function update(index: number, patch: Partial<TestCaseDraft>) {
    setCases((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }
  function remove(index: number) {
    setCases((prev) => prev.filter((_, i) => i !== index));
  }
  function add() {
    setCases((prev) => [...prev, { name: '', harnessCode: DEFAULT_HARNESS, weight: 1 }]);
  }

  return (
    <>
      <div className={styles.infoBanner}>
        Cachés à l'étudiant · chaque harnais renvoie vrai/faux · note = part des poids réussis
      </div>

      <div className={[styles.list, styles.harnessList].join(' ')}>
        {cases.map((c, i) => (
          <div key={i} className={styles.harnessCard}>
            <div className={styles.harnessCardHead}>
              <input
                className={styles.input}
                value={c.name}
                placeholder="Nom du cas (ex. Cas nominal)"
                maxLength={128}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <span className={styles.weightLabel}>Poids</span>
              <input
                className={[styles.input, styles.weightInput].join(' ')}
                type="number"
                min={1}
                value={c.weight}
                onChange={(e) => update(i, { weight: Math.max(1, Number(e.target.value) || 1) })}
              />
              <button
                type="button"
                className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                aria-label="Supprimer le harnais"
                onClick={() => remove(i)}
              >
                <TrashCan width={15} height={15} />
              </button>
            </div>
            <CodeEditor
              value={c.harnessCode}
              onChange={(harnessCode) => update(i, { harnessCode })}
              language={language}
              ariaLabel={`Code du harnais ${i + 1}`}
            />
          </div>
        ))}
      </div>

      <button type="button" className={styles.addButton} onClick={add}>
        + Ajouter un harnais
      </button>

      <EditorFooter>
        <div className={styles.footer}>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.ghostButton} onClick={onCancel}>
            Annuler
          </button>
          <button type="button" className={styles.primaryButton} onClick={() => onSave(cases)}>
            Enregistrer
          </button>
        </div>
      </EditorFooter>
    </>
  );
}
