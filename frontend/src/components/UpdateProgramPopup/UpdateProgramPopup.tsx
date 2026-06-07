import React, { useEffect, useRef, useState } from 'react';
import styles from './UpdateProgramPopup.module.css';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { DEFAULT_PALETTE, FIELD_MAX_LENGTH, defaultLabels } from './labels.ts';
import type {
  MaybePromise,
  ProgramData,
  ProgramUpdate,
  UpdateProgramPopupLabels,
} from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ces types depuis ce module.
export type {
  MaybePromise,
  ProgramData,
  ProgramUpdate,
  UpdateProgramPopupLabels,
} from './types.ts';

interface UpdateProgramPopupProps {
  onClose: (...args: unknown[]) => unknown;
  /**
   * Émise à l'enregistrement avec le programme modifié ; le parent persiste comme il veut.
   * Peut être async (POST/PUT) : le popup affiche un spinner, attend sa résolution puis se ferme.
   * Si elle rejette, le popup reste ouvert et affiche une erreur.
   */
  onSave: (program: ProgramUpdate) => MaybePromise<unknown>;
  /** Programme à éditer (pré-remplit le formulaire). */
  program: ProgramData;
  /**
   * Codes des autres programmes du même établissement (sans celui édité).
   * Sert à vérifier l'unicité du code ; vide par défaut (pas de vérification).
   */
  existingCodes?: string[];
  /** Couleurs prédéfinies proposées dans la palette. */
  palette?: string[];
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<UpdateProgramPopupLabels>;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <span className={styles.spinner} aria-hidden="true" />;
}

export function UpdateProgramPopup({
  onClose,
  onSave,
  program,
  existingCodes = [],
  palette = DEFAULT_PALETTE,
  labels,
}: UpdateProgramPopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  // Champs du formulaire, pré-remplis avec le programme existant.
  const [color, setColor] = useState(program.color || DEFAULT_PALETTE[0]);
  const [code, setCode] = useState(program.code);
  const [name, setName] = useState(program.name);
  const [cohort, setCohort] = useState(program.cohort);

  /** Enregistrement async en cours ? Pilote le spinner et empêche les doubles déclenchements. */
  const [pending, setPending] = useState(false);
  /** Message d'erreur du dernier enregistrement (null = aucune). */
  const [error, setError] = useState<string | null>(null);
  /** Composant monté ? Ignore les réponses async qui reviennent après démontage. */
  const mountedRef = useRef(true);
  /** Jeton de la dernière requête async : ignore les réponses périmées (race conditions). */
  const requestRef = useRef(0);

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);

  // Marque le composant comme démonté : les callbacks async résolus ensuite sont ignorés.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Joue l'animation de sortie puis exécute l'action (fermeture immédiate si reduced-motion). */
  function requestClose(action: () => void) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      action();
      return;
    }
    pendingAction.current = action;
    setIsClosing(true);
  }

  function handleAnimationEnd(event: React.AnimationEvent<HTMLDivElement>) {
    if (isClosing && event.target === event.currentTarget) {
      pendingAction.current?.();
      pendingAction.current = null;
    }
  }

  /** Le code saisi existe-t-il déjà dans l'établissement (hors programme édité) ? */
  const trimmedCode = code.trim();
  const codeTaken =
    trimmedCode !== '' && existingCodes.some((c) => c.toUpperCase() === trimmedCode.toUpperCase());

  const canSave = trimmedCode !== '' && name.trim() !== '' && cohort.trim() !== '' && !codeTaken;

  async function save() {
    if (!canSave || pending) return;
    const update: ProgramUpdate = {
      name: name.trim(),
      code: trimmedCode,
      cohort: cohort.trim(),
      color,
    };
    const reqId = ++requestRef.current;
    setError(null);
    setPending(true);
    try {
      // onSave peut être async (POST/PUT) : on attend sa résolution avant de fermer.
      await onSave(update);
      if (!mountedRef.current || requestRef.current !== reqId) return;
      requestClose(onClose); // succès → ferme via onClose
    } catch {
      // Échec → le popup reste ouvert et affiche l'erreur.
      if (!mountedRef.current || requestRef.current !== reqId) return;
      setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(false);
    }
  }

  return (
    <>
      <div
        className={`${styles['update-program']}${isClosing ? ` ${styles.closing}` : ''}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose(onClose);
        }}
      >
        <div onAnimationEnd={handleAnimationEnd}>
          <header>
            <div>
              <h1>{t.title}</h1>
              <p>{t.subtitle}</p>
            </div>
            <button onClick={() => requestClose(onClose)}>✕</button>
          </header>

          <section className={styles['color-group']}>
            <span className={styles.preview} style={{ background: color }} aria-hidden="true">
              <span style={{ color: contrastingTextColor(color) }}>
                {code.trim().slice(0, 3) || '?'}
              </span>
            </span>
            <div className={styles['palette-group']}>
              <span className={styles['field-label']}>{t.colorLabel}</span>
              <div className={styles.palette}>
                {palette.map((swatch, index) => {
                  const selected = swatch.toLowerCase() === color.toLowerCase();
                  return (
                    <button
                      key={`${swatch}-${index}`}
                      type="button"
                      className={`${styles.swatch}${selected ? ` ${styles.selected}` : ''}`}
                      style={
                        { ['--swatch-color']: swatch, background: swatch } as React.CSSProperties
                      }
                      aria-label={swatch}
                      aria-pressed={selected}
                      onClick={() => setColor(swatch)}
                    />
                  );
                })}
                <label className={styles['add-color']} aria-label={t.addColorLabel}>
                  +
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
                </label>
              </div>
            </div>
          </section>

          <label className={`${styles.field}${codeTaken ? ` ${styles.invalid}` : ''}`}>
            <span>{t.codeLabel}</span>
            <div>
              <input
                type="text"
                placeholder={t.codePlaceholder}
                maxLength={FIELD_MAX_LENGTH}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                aria-invalid={codeTaken}
              />
            </div>
            {codeTaken && <span className={styles['field-error']}>{t.codeTaken}</span>}
          </label>

          <label className={styles.field}>
            <span>{t.nameLabel}</span>
            <div>
              <input
                type="text"
                placeholder={t.namePlaceholder}
                maxLength={FIELD_MAX_LENGTH}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </label>

          <label className={styles.field}>
            <span>{t.cohortLabel}</span>
            <div>
              <input
                type="text"
                placeholder={t.cohortPlaceholder}
                maxLength={FIELD_MAX_LENGTH}
                value={cohort}
                onChange={(e) => setCohort(e.target.value)}
              />
            </div>
          </label>

          <footer>
            <button type="button" onClick={() => requestClose(onClose)}>
              {t.cancel}
            </button>
            <button type="button" onClick={save} disabled={!canSave || pending}>
              {pending ? <Spinner /> : t.save}
            </button>
          </footer>
        </div>
      </div>

      {error && (
        <ErrorPopup
          content={error}
          labels={{ title: t.errorTitle, close: t.errorClose }}
          onClose={() => setError(null)}
        />
      )}
    </>
  );
}
