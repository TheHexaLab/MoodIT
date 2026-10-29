import React, { useState } from 'react';
import styles from './AnnouncementView.module.css';
import { Popup } from '../../Popup/Popup';
import { PopupVariant } from '../../Popup/popupVariant';
import { usePopupController } from '../../Popup/popupController';
import { Spinner } from '../../Spinner/Spinner';
import { MAX_POST_CONTENT_LENGTH } from '../../../helpers/forumLimits';
import { type AnnouncementDraft } from '../../../pages/Dashboard/dashboardApi';
import { type ForumPost } from '../../../types/domain';
import { type MaybePromise } from '../ChannelView/useChannelMessages';
import {
  ANNOUNCEMENT_COLORS,
  DEFAULT_ANNOUNCEMENT_COLOR,
  type AnnouncementColor,
} from './announcementColors';
import {
  ANNOUNCEMENT_TITLE_MAX_LENGTH,
  defaultAnnouncementLabels,
  type AnnouncementLabels,
} from './labels';

interface AnnouncementFormPopupProps {
  onClose: (...args: unknown[]) => unknown;
  /** Publie l'annonce ; le popup reste ouvert (avec une erreur) si la promesse rejette. */
  onSubmit: (draft: AnnouncementDraft) => MaybePromise<unknown>;
  /** Annonce à modifier (pré-remplit le formulaire) ; absente = création. */
  initial?: ForumPost;
  labels?: Partial<AnnouncementLabels>;
}

/** Date au format des champs `<input type="date">` (AAAA-MM-JJ, heure locale). */
function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Formulaire de création ou de modification d'une annonce. */
export function AnnouncementFormPopup({
  onClose,
  onSubmit,
  initial,
  labels,
}: AnnouncementFormPopupProps): React.ReactElement {
  const t = { ...defaultAnnouncementLabels, ...labels };
  const popup = usePopupController();
  const { requestClose } = popup;
  const heading = initial ? t.editTitle : t.formTitle;
  const initialDate = initial?.expiresAt ? toDateInput(new Date(initial.expiresAt)) : '';

  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [color, setColor] = useState<AnnouncementColor>(
    (ANNOUNCEMENT_COLORS.find((c) => c.key === initial?.color)?.key ?? DEFAULT_ANNOUNCEMENT_COLOR)
  );
  const [never, setNever] = useState(!initialDate);
  const [date, setDate] = useState(initialDate);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!title.trim()) return setError(t.titleRequired);
    if (!never && !date) return setError(t.dateRequired);
    // Une date passée inchangée (annonce déjà expirée qu'on corrige) reste acceptée.
    if (!never && date < toDateInput(new Date()) && date !== initialDate) {
      return setError(t.datePast);
    }

    setPending(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim(),
        content: content.trim(),
        color,
        // Fin de la journée choisie, en heure locale : l'annonce reste visible toute la journée.
        expiresAt: never ? null : new Date(`${date}T23:59:59`).toISOString(),
      });
      requestClose(onClose);
    } catch {
      setError(initial ? t.saveError : t.publishError);
    } finally {
      setPending(false);
    }
  }

  return (
    <Popup
      variant={PopupVariant.Form}
      label={heading}
      onClose={onClose}
      controller={popup}
      className={styles['announcement-form']}
    >
      <form onSubmit={submit} noValidate>
        <header>
          <div>
            <h1>{heading}</h1>
            <p>{t.formSubtitle}</p>
          </div>
          <button type="button" aria-label={t.cancel} onClick={() => requestClose(onClose)}>
            ✕
          </button>
        </header>

        <label>
          <span>{t.titleLabel}</span>
          <input
            type="text"
            value={title}
            maxLength={ANNOUNCEMENT_TITLE_MAX_LENGTH}
            placeholder={t.titlePlaceholder}
            onChange={(e) => {
              setTitle(e.target.value);
              setError(null);
            }}
            autoFocus
          />
        </label>

        <label>
          <span>{t.contentLabel}</span>
          <textarea
            value={content}
            maxLength={MAX_POST_CONTENT_LENGTH}
            placeholder={t.contentPlaceholder}
            rows={4}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>

        <fieldset>
          <legend>{t.colorLabel}</legend>
          <div role="radiogroup" aria-label={t.colorLabel}>
            {ANNOUNCEMENT_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                role="radio"
                aria-checked={color === c.key}
                aria-label={c.label}
                title={c.label}
                style={{ '--ann-color': c.hex } as React.CSSProperties}
                onClick={() => setColor(c.key)}
              />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>{t.expiryLabel}</legend>
          <div>
            <input
              type="date"
              aria-label={t.expiryLabel}
              value={date}
              min={toDateInput(new Date())}
              disabled={never}
              onChange={(e) => {
                setDate(e.target.value);
                setError(null);
              }}
            />
            <label>
              <input
                type="checkbox"
                checked={never}
                onChange={(e) => {
                  setNever(e.target.checked);
                  setError(null);
                }}
              />
              <span>{t.never}</span>
            </label>
          </div>
        </fieldset>

        {error && (
          <p role="alert" className={styles['form-error']}>
            {error}
          </p>
        )}

        <footer>
          <button type="button" onClick={() => requestClose(onClose)}>
            {t.cancel}
          </button>
          <button type="submit" disabled={pending}>
            {pending ? <Spinner tone="current" size={16} /> : initial ? t.save : t.publish}
          </button>
        </footer>
      </form>
    </Popup>
  );
}
