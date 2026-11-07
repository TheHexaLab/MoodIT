import React, { useEffect, useRef, useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter } from './EditorShell';
import { CodeEditor } from './CodeEditor';
import { TrashCan } from '../../assets/TrashCan';
import { type TestCaseDraft } from './editorTypes';
import { type Language } from '../../types/domain';
import { defaultHarnessLabels, type HarnessLabels } from './harnessLabels';

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
 * Chaque harnais = nom (retour à l'étudiant) + poids (crédit partiel) + code de TEST
 * exécutable. Interprétés/SQL/vues : code qui renvoie vrai/faux, dans le langage configuré
 * (Language.harness_language_id). Compilés (#116) : un VRAI test du langage (JUnit, NUnit,
 * go test, cargo test, moodit_check.h), exécuté par le runner Docker isolé d'execution-service
 * — le gabarit du langage montre la forme attendue. Rendu dans la coquille commune
 * (`EditorShell`) par `QuizEditor` : page empilée, pas un nouveau popup.
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
  // On reflète les harnais existants tels quels (liste vide si aucun) : pas d'ajout
  // automatique — l'utilisateur ajoute via « + Ajouter un harnais ».
  const [cases, setCases] = useState<TestCaseDraft[]>(() => testCases.map((tc) => ({ ...tc })));

  // Défilement vers le cas qu'on vient d'ajouter : le bouton « + » est dans le pied FIXE, donc
  // le nouveau cas (en bas de la liste défilante) peut être hors écran. `pendingScroll` est armé
  // par `add()` et consommé après le rendu.
  const listRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef(false);

  // Page harnais = contexte Code → on s'assure que les langages sont chargés.
  useEffect(() => {
    onRequestLanguages?.();
  }, [onRequestLanguages]);

  // Après l'ajout d'un cas, amène le nouveau (dernière carte) à l'écran. rAF : laisse l'éditeur
  // de code finir son auto-dimensionnement avant de calculer la position.
  useEffect(() => {
    if (!pendingScroll.current) return;
    pendingScroll.current = false;
    const id = requestAnimationFrame(() => {
      const last = listRef.current?.lastElementChild;
      last?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [cases.length]);

  function update(index: number, patch: Partial<TestCaseDraft>) {
    setCases((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }
  function remove(index: number) {
    setCases((prev) => prev.filter((_, i) => i !== index));
  }
  function add() {
    pendingScroll.current = true;
    // Squelette du langage de la question (ex. HTML → harnais JS spécifique), pas un stub fixe.
    setCases((prev) => [...prev, { name: '', harnessCode: defaultHarnessCode ?? '', weight: 1 }]);
  }

  // Enregistrement bloqué s'il n'y a aucun cas, ou si l'un n'a pas de nom / poids ≤ 0.
  const isValid =
    cases.length > 0 && cases.every((c) => c.name.trim() !== '' && c.weight > 0);

  return (
    <>
      <div className={styles.infoBanner}>{t.infoBanner}</div>

      <div className={[styles.list, styles.harnessList].join(' ')} ref={listRef}>
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
            <CodeEditor
              value={c.harnessCode}
              onChange={(harnessCode) => update(i, { harnessCode })}
              language={harnessLanguage?.name}
              ariaLabel={t.codeAria(i + 1)}
            />
          </div>
        ))}
      </div>

      <EditorFooter>
        {/* Bouton d'ajout dans le pied FIXE (hors du corps défilant) pour rester toujours visible. */}
        <div className={styles.footerStack}>
          <button type="button" className={styles.addButton} onClick={add}>
            + {t.add}
          </button>
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
        </div>
      </EditorFooter>
    </>
  );
}
