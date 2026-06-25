import React from 'react';
import styles from './questions.module.css';
import { Check } from '../../../../assets/Check';
import { X } from '../../../../assets/X';
import { type QuestionViewProps } from './types';

/**
 * Rendu des trois types « à options » : Vrai/Faux, Choix unique (radio, sélection
 * exclusive) et Choix multiple (cases à cocher). Vrai/Faux s'affiche en deux
 * colonnes ; les autres en liste verticale.
 *
 * En révision : les bonnes réponses sont surlignées (✓ teal), les options
 * choisies à tort en rouge (✗), à partir de `result.correctAnswerIds` /
 * `selectedAnswerIds` (vérité serveur).
 */
export function ChoiceQuestion({
  question,
  mode,
  answer,
  result,
  onChange,
}: QuestionViewProps): React.ReactElement {
  const multiple = question.qType === 'multiple_choice';
  const isTrueFalse = question.qType === 'true_false';
  const options = question.answers ?? [];
  const selected = answer?.kind === 'choice' ? answer.answerIds : [];

  const correctIds = new Set(result?.correctAnswerIds ?? []);
  const pickedIds = new Set(result?.selectedAnswerIds ?? selected);

  function toggle(optionId: number) {
    if (mode === 'review') return;
    if (multiple) {
      const next = selected.includes(optionId)
        ? selected.filter((id) => id !== optionId)
        : [...selected, optionId];
      onChange({ kind: 'choice', answerIds: next });
    } else {
      onChange({ kind: 'choice', answerIds: [optionId] });
    }
  }

  const helper = multiple ? 'Plusieurs réponses possibles.' : null;

  return (
    <div>
      {helper && <p className={styles.helper}>{helper}</p>}
      <div className={isTrueFalse ? styles.optionsGrid : styles.options}>
        {options.map((opt) => {
          const isSelected = selected.includes(opt.id);

          // Classe d'état + tonalité de l'icône.
          // En révision (choix multiple), chaque option a un « bon état » :
          //  - à cocher + cochée      → fond vert  + ✓
          //  - à cocher + non cochée  → contour vert (sans fond) + ✓ (manquée)
          //  - à NE PAS cocher + cochée    → fond rouge + ✗
          //  - à NE PAS cocher + non cochée → contour vert (sans fond) + ✓ (bien évitée)
          // V/F & choix unique : un distracteur laissé décoché reste neutre.
          let stateClass = '';
          let iconTone: ReviewTone = 'muted';
          // L'état « contour vert » (sans fond) affiche le crochet dans un cercle vert.
          let iconCircled = false;
          if (mode === 'review') {
            const correct = correctIds.has(opt.id);
            const picked = pickedIds.has(opt.id);
            if (correct) {
              stateClass = picked ? styles.optionCorrect : styles.optionCorrectMissed;
              iconTone = 'ok';
              iconCircled = !picked;
            } else if (picked) {
              stateClass = styles.optionWrong;
              iconTone = 'bad';
            } else if (multiple) {
              stateClass = styles.optionCorrectMissed;
              iconTone = 'ok';
              iconCircled = true;
            }
          } else if (isSelected) {
            stateClass = styles.optionSelected;
          }

          return (
            <button
              type="button"
              key={opt.id}
              className={[styles.option, isTrueFalse ? styles.optionCentered : '', stateClass]
                .filter(Boolean)
                .join(' ')}
              disabled={mode === 'review'}
              aria-pressed={mode === 'answer' ? isSelected : undefined}
              onClick={() => toggle(opt.id)}
            >
              {mode === 'review' ? (
                <ReviewIcon tone={iconTone} circled={iconCircled} />
              ) : (
                <Control on={isSelected} multiple={multiple} />
              )}
              <span className={styles.optionLabel}>{opt.content}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Pastille de contrôle (radio plein ou case cochée) en mode saisie. */
function Control({ on, multiple }: { on: boolean; multiple: boolean }): React.ReactElement {
  const shape = multiple ? styles.controlCheckbox : styles.controlRadio;
  return (
    <span className={[styles.control, shape, on ? styles.controlOn : ''].filter(Boolean).join(' ')}>
      {on && (multiple ? <Check width={12} height={12} /> : <span className={styles.radioDot} />)}
    </span>
  );
}

/** Tonalité de l'icône de statut en révision. */
type ReviewTone = 'ok' | 'bad' | 'muted';

/** Icône de statut (✓ bon état / ✗ erreur / ○ neutre) en révision. */
function ReviewIcon({
  tone,
  circled,
}: {
  tone: ReviewTone;
  /** Cercle vert pâle autour du crochet (état « contour » du choix multiple). */
  circled?: boolean;
}): React.ReactElement {
  if (tone === 'ok') {
    return (
      <span
        className={[styles.statusIcon, styles.statusOk, circled ? styles.statusIconCircle : '']
          .filter(Boolean)
          .join(' ')}
      >
        <Check width={14} height={14} />
      </span>
    );
  }
  if (tone === 'bad') {
    return (
      <span className={[styles.statusIcon, styles.statusBad].join(' ')}>
        <X width={12} height={12} />
      </span>
    );
  }
  return <span className={[styles.statusIcon, styles.statusMuted].join(' ')}>○</span>;
}
