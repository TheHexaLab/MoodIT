import React, { useEffect, useRef, useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter } from './EditorShell';
import { CodeEditor } from './CodeEditor';
import { TrashCan } from '../../assets/TrashCan';
import { type TestCaseDraft } from './editorTypes';
import { type Language } from '../../types/domain';
import { defaultHarnessLabels, type HarnessLabels } from './harnessLabels';

/**
 * Vrai si le langage (du harnais = de la question pour les compilés) est COMPILÉ → la question
 * se note par CAS STRUCTURÉS (#116 : appeler une fonction, comparer la sortie hors sandbox), et non
 * par harnais-code. Miroir de la décision backend (CodeAssembler.isCompiled / QuizService).
 */
function isCompiledHarnessLang(name?: string): boolean {
  switch ((name ?? '').trim().toLowerCase()) {
    case 'c':
    case 'c++':
    case 'cpp':
    case 'go':
    case 'rust':
    case 'c#':
    case 'csharp':
    case 'java':
      return true;
    default:
      return false;
  }
}

/** Modes de comparaison d'un cas structuré (valeur envoyée au backend). */
const COMPARE_MODES = ['exact', 'float', 'unordered'] as const;

interface HarnessBodyProps {
  /** Harnais courants (édités en place ; renvoyés par `onSave`). */
  testCases: TestCaseDraft[];
  /**
   * Langage DES HARNAIS (résolu via Language.harnessLanguageId) — pour la COLORATION
   * (`.name`). Peut différer du langage de la question (ex. HTML → harnais JS).
   */
  harnessLanguage?: Language;
  /**
   * Squelette d'un NOUVEAU harnais (gabarit du langage de la question, cf. defaultHarness).
   * Précalculé par le parent car il dépend du langage de la question ET du langage de harnais.
   */
  defaultHarnessCode?: string;
  /** Demande le chargement (paresseux) des langages — le harnais est du Code. */
  onRequestLanguages?: () => void;
  /** Textes (surcharge partielle des défauts). */
  labels?: Partial<HarnessLabels>;
  /** Annule (« Annuler » / chevron retour) : retour à la question, sans appliquer. */
  onCancel: () => void;
  /** Valide les harnais édités (le parent les réinjecte dans le brouillon de question). */
  onSave: (testCases: TestCaseDraft[]) => void;
}

/**
 * Champ de poids : saisie en TEXTE local (champ vide / intermédiaire permis pendant
 * la frappe, sinon le forçage à ≥ 1 à chaque touche empêche de remplacer la valeur).
 * Borné à un entier ≥ 1 au `blur`. Se resynchronise sur la valeur externe HORS-focus
 * (ex. suppression d'une ligne → réindexation des cartes). Tant que vide, remonte 0
 * (→ bloque l'enregistrement via la validation parente).
 */
function WeightInput({
  value,
  onChange,
  className,
}: {
  value: number;
  onChange: (weight: number) => void;
  className?: string;
}): React.ReactElement {
  const [text, setText] = useState(String(value));
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setText(String(value));
  }, [value]);
  return (
    <input
      className={className}
      type="number"
      min={1}
      step={1}
      value={text}
      aria-invalid={!(Number(text) > 0)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        onChange(raw === '' ? 0 : Number(raw));
      }}
      onBlur={() => {
        focusedRef.current = false;
        const n = Math.trunc(Number(text));
        const clamped = n >= 1 ? n : 1;
        setText(String(clamped));
        onChange(clamped);
      }}
    />
  );
}

/**
 * Corps « Harnais de test » : édition des harnais cachés d'une question Code.
 * Chaque harnais = nom (retour à l'étudiant) + poids (crédit partiel) + code qui
 * renvoie vrai/faux. Le langage des harnais est celui configuré pour le langage de
 * la question (Language.harness_language_id) — voir [[quiz-subsystem]]. Rendu dans la
 * coquille commune (`EditorShell`) par `QuizEditor` : page empilée, pas un nouveau popup.
 */
export function HarnessBody({
  testCases,
  harnessLanguage,
  defaultHarnessCode,
  onRequestLanguages,
  labels,
  onCancel,
  onSave,
}: HarnessBodyProps): React.ReactElement {
  const t = { ...defaultHarnessLabels, ...labels };
  // Langage compilé → cas STRUCTURÉS (entry/args/attendu) ; sinon harnais-code (#116).
  const structured = isCompiledHarnessLang(harnessLanguage?.name);
  // On reflète les harnais existants tels quels (liste vide si aucun) : pas d'ajout
  // automatique — l'utilisateur ajoute via « + Ajouter un harnais ».
  const [cases, setCases] = useState<TestCaseDraft[]>(() => testCases.map((tc) => ({ ...tc })));

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
    if (structured) {
      // Cas structuré : expression renvoyant la valeur + attendu + comparaison (pas de harnais-code).
      setCases((prev) => [
        ...prev,
        { name: '', harnessCode: '', expr: '', expectedJson: '', compareMode: 'exact', weight: 1 },
      ]);
      return;
    }
    // Squelette du langage de la question (ex. HTML → harnais JS spécifique), pas un stub fixe.
    setCases((prev) => [...prev, { name: '', harnessCode: defaultHarnessCode ?? '', weight: 1 }]);
  }

  // Enregistrement bloqué s'il n'y a aucun cas, ou si l'un n'a pas de nom / poids ≤ 0 ; en mode
  // structuré, l'expression est aussi requise.
  const isValid =
    cases.length > 0 &&
    cases.every(
      (c) => c.name.trim() !== '' && c.weight > 0 && (!structured || (c.expr ?? '').trim() !== '')
    );

  return (
    <>
      <div className={styles.infoBanner}>{structured ? t.structuredInfoBanner : t.infoBanner}</div>

      <div className={[styles.list, styles.harnessList].join(' ')}>
        {cases.map((c, i) => (
          <div key={i} className={styles.harnessCard}>
            <div className={styles.harnessCardHead}>
              <div className={styles.harnessFields}>
                <input
                  className={styles.input}
                  aria-invalid={c.name.trim() === ''}
                  value={c.name}
                  placeholder={t.namePlaceholder}
                  maxLength={128}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
                {/* <label> englobant : « Poids » devient le nom accessible du champ. */}
                <label className={styles.weightField}>
                  <span className={styles.weightLabel}>{t.weightLabel}</span>
                  <WeightInput
                    className={[styles.input, styles.weightInput].join(' ')}
                    value={c.weight}
                    onChange={(weight) => update(i, { weight })}
                  />
                </label>
              </div>
              <button
                type="button"
                className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                aria-label={t.deleteAria}
                onClick={() => remove(i)}
              >
                <TrashCan width={15} height={15} />
              </button>
            </div>
            {structured ? (
              <div className={styles.harnessFields}>
                <label className={styles.weightField}>
                  <span className={styles.weightLabel}>{t.exprLabel}</span>
                  <CodeEditor
                    value={c.expr ?? ''}
                    onChange={(expr) => update(i, { expr })}
                    language={harnessLanguage?.name}
                    ariaLabel={t.exprAria(i + 1)}
                  />
                </label>
                <label className={styles.weightField}>
                  <span className={styles.weightLabel}>{t.expectedLabel}</span>
                  <textarea
                    className={styles.input}
                    value={c.expectedJson ?? ''}
                    placeholder={t.expectedPlaceholder}
                    rows={2}
                    onChange={(e) => update(i, { expectedJson: e.target.value })}
                  />
                </label>
                <label className={styles.weightField}>
                  <span className={styles.weightLabel}>{t.compareLabel}</span>
                  <select
                    className={styles.input}
                    value={c.compareMode ?? 'exact'}
                    onChange={(e) => update(i, { compareMode: e.target.value })}
                  >
                    {COMPARE_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <CodeEditor
                value={c.harnessCode}
                onChange={(harnessCode) => update(i, { harnessCode })}
                language={harnessLanguage?.name}
                ariaLabel={t.codeAria(i + 1)}
              />
            )}
          </div>
        ))}
      </div>

      <button type="button" className={styles.addButton} onClick={add}>
        + {t.add}
      </button>

      <EditorFooter>
        <div className={styles.footer}>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.ghostButton} onClick={onCancel}>
            {t.cancel}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!isValid}
            onClick={() => onSave(cases)}
          >
            {t.save}
          </button>
        </div>
      </EditorFooter>
    </>
  );
}
