import React, { useEffect, useRef, useState } from 'react';
import styles from './EditProfilePopup.module.css';
import { Camera } from '../../assets/Camera.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { DEFAULT_PALETTE, NAME_MAX_LENGTH, defaultLabels } from './labels.ts';
import type { EditProfilePopupLabels, MaybePromise, ProfileUpdate, ProfileUser } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ces types depuis ce module.
export type { EditProfilePopupLabels, MaybePromise, ProfileUpdate, ProfileUser } from './types.ts';

interface EditProfilePopupProps {
  onClose: (...args: unknown[]) => unknown;
  /**
   * Émise à l'enregistrement avec le profil saisi ; le parent persiste comme il veut.
   * Peut être async (POST) : le popup affiche un spinner, attend sa résolution puis se ferme.
   * Si elle rejette, le popup reste ouvert et affiche une erreur.
   */
  onSave: (profile: ProfileUpdate) => MaybePromise<unknown>;
  /** Informations de l'utilisateur à éditer. */
  user: ProfileUser;
  /** Couleurs prédéfinies proposées dans la palette. */
  palette?: string[];
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<EditProfilePopupLabels>;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <span className={styles.spinner} aria-hidden="true" />;
}

export function EditProfilePopup({
  onClose,
  onSave,
  user,
  palette = DEFAULT_PALETTE,
  labels,
}: EditProfilePopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  const username = user.username;
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [avatarColor, setAvatarColor] = useState(user.avatarColor || DEFAULT_PALETTE[0]);
  /** Photo affichée : URL existante (user) ou aperçu local d'une photo choisie. */
  const [avatarPhoto, setAvatarPhoto] = useState<string | null>(user.avatarUrl ?? null);
  /** Fichier de la nouvelle photo choisie (null = aucune nouvelle / retirée). */
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  /** La photo a-t-elle été modifiée par rapport à l'état initial ? */
  const [photoChanged, setPhotoChanged] = useState(false);

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

  /** La couleur custom change seulement l'avatar (pas ajoutée à la palette). */
  function pickCustomColor(color: string) {
    setAvatarColor(color);
  }

  /** Sélection d'une photo : aperçu local (la persistance n'est pas encore branchée). */
  function pickPhoto(file: File | null) {
    if (!file) return;
    setAvatarPhoto((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setPhotoFile(file);
    setPhotoChanged(true);
  }

  /** Retire la photo : revient à la pastille colorée + initiales. */
  function removePhoto() {
    setAvatarPhoto((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
      return null;
    });
    setPhotoFile(null);
    setPhotoChanged(true);
  }

  function initials(): string {
    return `${firstName[0] ?? ''}${lastName[0] ?? ''}`.toUpperCase();
  }

  const canSave = firstName.trim() !== '' && lastName.trim() !== '';

  async function save() {
    if (!canSave || pending) return;
    const profile: ProfileUpdate = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      avatarColor,
      // File = nouvelle photo, null = retirée, undefined = inchangée.
      photo: photoChanged ? photoFile : undefined,
    };
    const reqId = ++requestRef.current;
    setError(null);
    setPending(true);
    try {
      // onSave peut être async (POST) : on attend sa résolution avant de fermer.
      await onSave(profile);
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
        className={`${styles['edit-profile']}${isClosing ? ` ${styles.closing}` : ''}`}
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

          <section className={styles.avatar}>
            <div>
              <label className={styles['avatar-edit']}>
                <span
                  className={styles.preview}
                  style={
                    avatarPhoto
                      ? {
                          backgroundImage: `url(${avatarPhoto})`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                        }
                      : { background: avatarColor }
                  }
                >
                  {!avatarPhoto && (
                    <span style={{ color: contrastingTextColor(avatarColor) }}>{initials()}</span>
                  )}
                </span>
                <span className={styles['camera-badge']}>
                  <Camera width="0.875rem" height="0.875rem" />
                </span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    pickPhoto(e.target.files?.[0] ?? null);
                    e.target.value = '';
                  }}
                />
              </label>
              <div>
                <p>
                  {firstName} {lastName}
                </p>
                <p>@{username}</p>
                {avatarPhoto && (
                  <button type="button" className={styles['remove-photo']} onClick={removePhoto}>
                    {t.removePhoto}
                  </button>
                )}
              </div>
            </div>
            <div className={styles['palette-group']}>
              <span className={styles['field-label']}>{t.paletteLabel}</span>
              <div className={styles.palette}>
                {palette.map((color, index) => {
                  const selected = color.toLowerCase() === avatarColor.toLowerCase();
                  return (
                    <button
                      key={`${color}-${index}`}
                      type="button"
                      className={`${styles.swatch}${selected ? ` ${styles.selected}` : ''}`}
                      style={
                        { ['--swatch-color']: color, background: color } as React.CSSProperties
                      }
                      aria-label={color}
                      aria-pressed={selected}
                      onClick={() => setAvatarColor(color)}
                    />
                  );
                })}
                <label className={styles['add-color']} aria-label={t.addColorLabel}>
                  +
                  <input
                    type="color"
                    value={avatarColor}
                    onChange={(e) => pickCustomColor(e.target.value)}
                  />
                </label>
              </div>
            </div>
          </section>

          <label className={styles.field}>
            <span>{t.firstNameLabel}</span>
            <div>
              <input
                type="text"
                placeholder={t.firstNamePlaceholder}
                maxLength={NAME_MAX_LENGTH}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
          </label>

          <label className={styles.field}>
            <span>{t.lastNameLabel}</span>
            <div>
              <input
                type="text"
                placeholder={t.lastNamePlaceholder}
                maxLength={NAME_MAX_LENGTH}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
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
