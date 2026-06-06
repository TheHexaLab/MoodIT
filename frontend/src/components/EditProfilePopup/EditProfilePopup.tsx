import React, { useRef, useState } from 'react';
import styles from './EditProfilePopup.module.css';
import { Camera } from '../../assets/Camera.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';

/** Utilisateur édité (reflète les colonnes utiles de `User_`). */
export interface ProfileUser {
  username: string;
  first_name: string;
  last_name: string;
  avatar_color: string;
  /** URL de la photo de profil existante (si l'utilisateur en a une). */
  avatar_url?: string;
}

/** Modification de profil (reflète les colonnes éditables de `User_`). */
export interface ProfileUpdate {
  firstName: string;
  lastName: string;
  avatarColor: string;
  /** Photo : `File` = nouvelle photo à téléverser, `null` = retirée, `undefined` = inchangée. */
  photo?: File | null;
}

interface EditProfilePopupProps {
  onClose: (...args: unknown[]) => unknown;
  /** Émise à l'enregistrement avec le profil saisi ; le parent persiste comme il veut. */
  onSave: (profile: ProfileUpdate) => unknown;
  /** Informations de l'utilisateur à éditer. */
  user: ProfileUser;
  /** Couleurs prédéfinies proposées dans la palette. */
  palette?: string[];
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<EditProfilePopupLabels>;
}

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface EditProfilePopupLabels {
  /** Titre du panneau. */
  title: string;
  /** Description sous le titre. */
  subtitle: string;
  /** Libellé de la section avatar. */
  avatarLabel: string;
  /** Libellé au-dessus de la palette de couleurs. */
  paletteLabel: string;
  /** Libellé accessible du bouton d'ajout de couleur. */
  addColorLabel: string;
  /** Libellé du bouton de retrait de la photo. */
  removePhoto: string;
  /** Libellé du champ « prénom ». */
  firstNameLabel: string;
  /** Invite du champ « prénom ». */
  firstNamePlaceholder: string;
  /** Libellé du champ « nom ». */
  lastNameLabel: string;
  /** Invite du champ « nom ». */
  lastNamePlaceholder: string;
  /** Bouton « annuler ». */
  cancel: string;
  /** Bouton « enregistrer ». */
  save: string;
}

/**
 * Tous les textes par défaut affichés par le composant.
 */
const defaultLabels: EditProfilePopupLabels = {
  title: 'Modifier le profil',
  subtitle: 'Personnalise ton avatar et tes informations.',
  avatarLabel: 'Avatar',
  paletteLabel: 'Couleur de la pastille',
  addColorLabel: 'Ajouter une couleur',
  removePhoto: 'Retirer la photo',
  firstNameLabel: 'Prénom',
  firstNamePlaceholder: 'Ex. Marie',
  lastNameLabel: 'Nom',
  lastNamePlaceholder: 'Ex. Tremblay',
  cancel: 'Annuler',
  save: 'Enregistrer',
};

/** Couleurs prédéfinies par défaut (cf. tokens --avatar-* dans index.css). */
const DEFAULT_PALETTE = [
  '#0D9488', '#14B8A6', '#2DD4BF', '#0F766E', '#7D7D94',
];

/** Longueurs max alignées sur la table User_ : first_name et last_name en VARCHAR(128). */
const NAME_MAX_LENGTH = 128;

export function EditProfilePopup({
  onClose,
  onSave,
  user,
  palette = DEFAULT_PALETTE,
  labels,
}: EditProfilePopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  const username = user.username;
  const [firstName, setFirstName] = useState(user.first_name);
  const [lastName, setLastName] = useState(user.last_name);
  const [avatarColor, setAvatarColor] = useState(user.avatar_color || DEFAULT_PALETTE[0]);
  /** Photo affichée : URL existante (user) ou aperçu local d'une photo choisie. */
  const [avatarPhoto, setAvatarPhoto] = useState<string | null>(user.avatar_url ?? null);
  /** Fichier de la nouvelle photo choisie (null = aucune nouvelle / retirée). */
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  /** La photo a-t-elle été modifiée par rapport à l'état initial ? */
  const [photoChanged, setPhotoChanged] = useState(false);

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);

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

  function save() {
    if (!canSave) return;
    const profile: ProfileUpdate = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      avatarColor,
      // File = nouvelle photo, null = retirée, undefined = inchangée.
      photo: photoChanged ? photoFile : undefined,
    };
    requestClose(() => onSave(profile));
  }

  return (
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
                    ? { backgroundImage: `url(${avatarPhoto})`, backgroundSize: 'cover', backgroundPosition: 'center' }
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
              <p>{firstName} {lastName}</p>
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
                    style={{ ['--swatch-color']: color, background: color } as React.CSSProperties}
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
          <button type="button" onClick={save} disabled={!canSave}>
            {t.save}
          </button>
        </footer>
      </div>
    </div>
  );
}
