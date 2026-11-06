import React, { useEffect, useRef, useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter } from './EditorShell';
import { CodeEditor } from './CodeEditor';
import { Dropdown } from './Dropdown';
import { TrashCan } from '../../assets/TrashCan';
import { defaultStructuredExpr, type TestCaseDraft } from './editorTypes';
import { type Language } from '../../types/domain';
import { defaultHarnessLabels, type CompareMode, type HarnessLabels } from './harnessLabels';

/**
 * Modes de comparaison d'un cas structuré (valeur envoyée au backend). Ordre d'affichage du menu.
 * Les relationnels (`gt`/`ge`/`lt`/`le`) et `ne` sont évalués HORS sandbox : l'attendu reste la
 * borne cachée. Miroir de `ExecutionService.jsonMatches`.
 */
const COMPARE_MODES = ['exact', 'gt', 'ge', 'lt', 'le', 'ne', 'contains', 'regex', 'unordered'] as const;

/** Une sous-condition en édition : mode de comparaison + borne en TEXTE JSON (comme un attendu simple). */
interface Condition {
  compare: string;
  value: string;
}

/**
 * Modes « texte » : la borne est une CHAÎNE BRUTE (sous-chaîne ou motif regex), pas du JSON — donc
 * saisie sans guillemets ni antislashs doublés. On l'encode quand même en chaîne JSON pour le
 * transport (core/execution), et on la ré-affiche brute. Les autres modes gardent la saisie JSON.
 */
function isStringPatternMode(mode: string): boolean {
  return mode === 'contains' || mode === 'regex';
}

/** Déballe une chaîne JSON (`"abc"` → `abc`) ; si ce n'est pas une chaîne JSON, rend le texte tel quel. */
function unwrapJsonString(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === 'string') return v;
  } catch {
    /* pas du JSON valide → tel quel */
  }
  return raw;
}

/**
 * Conditions d'un cas, dérivées de ses champs transportés. Un cas « simple » (une condition) garde
 * `compareMode`/`expectedJson` tels quels ; un cas « composé » (plusieurs, reliées par ET/OU) les
 * encode dans `expectedJson` (objet `{conditions, connectors}`) avec `compareMode = "compound"` —
 * ainsi core/BD n'ont rien à savoir. Miroir de `ExecutionService` (mode `compound`).
 */
function readConditions(c: TestCaseDraft): { conds: Condition[]; connectors: string[] } {
  if ((c.compareMode ?? '') === 'compound') {
    const parsed = parseCompound(c.expectedJson ?? '');
    if (parsed && parsed.conds.length > 0) return parsed;
  }
  const mode = c.compareMode ?? 'exact';
  const raw = c.expectedJson ?? '';
  return {
    conds: [{ compare: mode, value: isStringPatternMode(mode) ? unwrapJsonString(raw) : raw }],
    connectors: [],
  };
}

/** Réécrit les conditions dans les champs transportés : forme simple si une seule, `compound` au-delà. */
function writeConditions(conds: Condition[], connectors: string[]): Partial<TestCaseDraft> {
  if (conds.length <= 1) {
    const only = conds[0] ?? { compare: 'exact', value: '' };
    // Modes texte : on encode la borne brute en chaîne JSON (guillemets/échappement automatiques).
    const expectedJson = isStringPatternMode(only.compare) ? JSON.stringify(only.value) : only.value;
    return { compareMode: only.compare, expectedJson };
  }
  return {
    compareMode: 'compound',
    expectedJson: JSON.stringify({
      conditions: conds.map((c) => ({ compare: c.compare, value: c.value })),
      connectors: connectors.slice(0, conds.length - 1),
    }),
  };
}

/** Parse prudemment l'objet composé (sans `any`) ; null si invalide. */
function parseCompound(json: string): { conds: Condition[]; connectors: string[] } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const conds = (Array.isArray(rec.conditions) ? rec.conditions : []).map((x) => {
    const r = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    return {
      compare: typeof r.compare === 'string' ? r.compare : 'exact',
      value: typeof r.value === 'string' ? r.value : '',
    };
  });
  const connectors = (Array.isArray(rec.connectors) ? rec.connectors : []).map((x) => (x === 'or' ? 'or' : 'and'));
  return { conds, connectors };
}

/** Résumé lisible de la combinaison. ET lie plus fort que OU : groupes ET (entre parenthèses) reliés par OU. */
function buildSummary(conds: Condition[], connectors: string[], t: HarnessLabels): string {
  const term = (c: Condition) =>
    `${t.compareSymbols[c.compare as CompareMode] ?? c.compare} ${(c.value ?? '').trim() || '…'}`;
  const groups: string[][] = [[term(conds[0])]];
  for (let k = 1; k < conds.length; k++) {
    if ((connectors[k - 1] === 'or' ? 'or' : 'and') === 'or') groups.push([term(conds[k])]);
    else groups[groups.length - 1].push(term(conds[k]));
  }
  return groups
    .map((g) => {
      const joined = g.join(` ${t.connectorOptions.and} `);
      return groups.length > 1 && g.length > 1 ? `(${joined})` : joined;
    })
    .join(` ${t.connectorOptions.or} `);
}

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
  // Mode STRUCTURÉ (#116) décidé comme au backend — PAR LA DONNÉE d'abord : un cas déjà porteur d'une
  // `expr` (ex. question convertie, chargée pour édition) force le mode structuré même si les langages
  // ne sont pas encore résolus. Sinon, on se base sur le langage compilé (nouvelle question).
  // Harnais-code PARTOUT, y compris les compilés : ceux-ci sont notés en DEUX processus (le code
  // étudiant dans un enfant isolé, le nonce/verdict dans le parent, hors de sa portée — cf. #116,
  // POO comprise). On ne reste en mode « cas structuré » que pour une question DÉJÀ convertie (un cas
  // porte une `expr`) ; une nouvelle question compilée part donc en harnais-code, comme les interprétés.
  const structured = testCases.some((c) => (c.expr ?? '').trim() !== '');
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

  // Après l'ajout d'un cas, amène le nouveau (dernière carte) à l'écran. rAF : laisse les éditeurs
  // de code finir leur auto-dimensionnement avant de calculer la position.
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
  /** Modifie les conditions du cas `index` (lecture → transformation → réécriture dans les champs). */
  function mutateConds(
    index: number,
    fn: (conds: Condition[], connectors: string[]) => { conds: Condition[]; connectors: string[] }
  ) {
    setCases((prev) =>
      prev.map((c, i) => {
        if (i !== index) return c;
        const { conds, connectors } = readConditions(c);
        const next = fn(conds.map((x) => ({ ...x })), [...connectors]);
        return { ...c, ...writeConditions(next.conds, next.connectors) };
      })
    );
  }
  function setCond(i: number, j: number, patch: Partial<Condition>) {
    mutateConds(i, (conds, connectors) => {
      conds[j] = { ...conds[j], ...patch };
      return { conds, connectors };
    });
  }
  function setConnector(i: number, j: number, value: string) {
    mutateConds(i, (conds, connectors) => {
      connectors[j] = value === 'or' ? 'or' : 'and';
      return { conds, connectors };
    });
  }
  function addCond(i: number) {
    mutateConds(i, (conds, connectors) => {
      conds.push({ compare: 'exact', value: '' });
      connectors.push('and');
      return { conds, connectors };
    });
  }
  function removeCond(i: number, j: number) {
    mutateConds(i, (conds, connectors) => {
      conds.splice(j, 1);
      connectors.splice(j === 0 ? 0 : j - 1, 1);
      return { conds, connectors };
    });
  }
  function remove(index: number) {
    setCases((prev) => prev.filter((_, i) => i !== index));
  }
  function add() {
    pendingScroll.current = true;
    if (structured) {
      // Cas structuré : expression renvoyant la valeur + attendu + comparaison (pas de harnais-code).
      // Pré-remplie d'un squelette commenté du langage (comme l'ancien gabarit de harnais).
      setCases((prev) => [
        ...prev,
        {
          name: '',
          harnessCode: '',
          expr: defaultStructuredExpr(harnessLanguage),
          expectedJson: '',
          compareMode: 'exact',
          weight: 1,
        },
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

  /**
   * Bloc « Conditions » d'un cas structuré : une ou plusieurs conditions (mode + borne), reliées par
   * ET/OU. Une seule → se stocke en forme simple ; au-delà → `compound`. Résumé lisible dès qu'il y a
   * plusieurs conditions (ET prioritaire sur OU).
   */
  function renderConditions(c: TestCaseDraft, i: number): React.ReactElement {
    const { conds, connectors } = readConditions(c);
    return (
      <div className={styles.structuredAside}>
        <span className={styles.weightLabel}>{t.conditionsLabel}</span>
        <div className={styles.conditions}>
          {conds.map((cond, j) => (
            <React.Fragment key={j}>
              <div className={styles.conditionRow}>
                <div className={styles.conditionCompare}>
                  <Dropdown
                    ariaLabel={t.compareLabel}
                    value={cond.compare}
                    options={COMPARE_MODES.map((m) => ({ value: m, label: t.compareOptions[m] }))}
                    onChange={(compare) => setCond(i, j, { compare })}
                  />
                </div>
                <div className={styles.conditionValue}>
                  <CodeEditor
                    value={cond.value}
                    onChange={(value) => setCond(i, j, { value })}
                    language={isStringPatternMode(cond.compare) ? undefined : 'json'}
                    placeholder={
                      isStringPatternMode(cond.compare) ? t.patternPlaceholder : t.expectedPlaceholder
                    }
                    minRows={1}
                    inline
                    ariaLabel={t.expectedAria(i + 1)}
                  />
                </div>
                {conds.length > 1 && (
                  <button
                    type="button"
                    className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                    aria-label={t.deleteConditionAria(j + 1)}
                    onClick={() => removeCond(i, j)}
                  >
                    <TrashCan width={15} height={15} />
                  </button>
                )}
              </div>
              {j < conds.length - 1 && (
                <div className={styles.connectorRow}>
                  <Dropdown
                    ariaLabel={t.connectorAria(j + 1)}
                    value={connectors[j] === 'or' ? 'or' : 'and'}
                    options={[
                      { value: 'and', label: t.connectorOptions.and },
                      { value: 'or', label: t.connectorOptions.or },
                    ]}
                    onChange={(v) => setConnector(i, j, v)}
                  />
                </div>
              )}
            </React.Fragment>
          ))}
          <button type="button" className={styles.addConditionButton} onClick={() => addCond(i)}>
            + {t.addCondition}
          </button>
          {conds.length > 1 && (
            <div className={styles.conditionSummary}>
              <span className={styles.conditionSummaryLabel}>{t.summaryPrefix}</span>{' '}
              {buildSummary(conds, connectors, t)}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={styles.infoBanner}>{structured ? t.structuredInfoBanner : t.infoBanner}</div>

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
            {structured ? (
              <div className={styles.structuredFields}>
                <label className={[styles.structuredField, styles.structuredExpr].join(' ')}>
                  <span className={styles.weightLabel}>{t.exprLabel}</span>
                  <CodeEditor
                    value={c.expr ?? ''}
                    onChange={(expr) => update(i, { expr })}
                    language={harnessLanguage?.name}
                    ariaLabel={t.exprAria(i + 1)}
                  />
                </label>
                {renderConditions(c, i)}
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
