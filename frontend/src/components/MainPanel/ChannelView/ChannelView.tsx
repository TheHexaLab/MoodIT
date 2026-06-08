import React from 'react';
import styles from './ChannelView.module.css';
import {
  type ChannelMessageAuthor,
  type CourseChannel,
} from '../../CourseChannelList/CourseChannelList';
import { getPrefixForType } from '../../CourseChannelList/channelTypePrefix';
import { type Course } from '../../CourseMenu/CourseMenu';
import { Send } from '../../../assets/Send';
import { contrastingTextColor } from '../../../helpers/color';

interface ChannelViewProps {
  /** Cours auquel appartient le canal (contexte d'en-tete). */
  course: Course;
  /** Canal selectionne (forum de f_type 'Discussion', rendu comme un canal/chat). */
  channel: CourseChannel;
}

/** Couleur d'avatar par defaut (= Program/User color par defaut en BD). */
const DEFAULT_AVATAR_COLOR = '#0a5cc0';

/** Heure courte (HH:MM) a partir d'un timestamp ISO. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-CA', { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Cle de jour (local) pour detecter un changement de date entre deux messages. */
function getDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Libelle du separateur de date (ex. "5 juin 2026"). */
function formatDaySeparator(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-CA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** Nom affiche d'un auteur (first_name + last_name). */
function getAuthorName(author: ChannelMessageAuthor): string {
  return `${author.first_name} ${author.last_name}`.trim() || author.username;
}

/** Deux initiales affichees dans l'avatar (first_name + last_name). */
function getInitials(author: ChannelMessageAuthor): string {
  const initials = `${author.first_name[0] ?? ''}${author.last_name[0] ?? ''}`.trim();
  return (initials || author.username[0] || '?').toUpperCase();
}

/**
 * Etat 5 — vue d'un canal de discussion (f_type 'Discussion').
 * Echange libre facon chat : liste des messages + zone de saisie.
 */
const ChannelView: React.FC<ChannelViewProps> = ({ course, channel }: ChannelViewProps) => {
  const messages = channel.messages ?? [];

  return (
    <div className={styles['channel-view']}>
      <header>
        <p>
          <span>{getPrefixForType(channel.type)}</span>
          {channel.name}
        </p>
        <span />
        <p>{course.title}</p>
      </header>

      <div>
        {messages.length === 0 ? (
          <div>
            <p>Aucun message dans ce canal pour l'instant.</p>
          </div>
        ) : (
          <ul>
            {messages.map((message, index) => {
              const avatarColor = message.author.avatar_color ?? DEFAULT_AVATAR_COLOR;
              const authorName = getAuthorName(message.author);
              const previous = messages[index - 1];
              const showDateSeparator =
                !previous || getDayKey(previous.created_at) !== getDayKey(message.created_at);
              return (
                <React.Fragment key={message.id}>
                  {showDateSeparator && (
                    <li role="separator">
                      <span>{formatDaySeparator(message.created_at)}</span>
                    </li>
                  )}
                  <li role="message">
                    <span
                      style={{ background: avatarColor, color: contrastingTextColor(avatarColor) }}
                    >
                      {getInitials(message.author)}
                    </span>
                    <div>
                      <p>
                        <span>{authorName}</span>
                        <span>{formatTime(message.created_at)}</span>
                      </p>
                      <p>{message.content}</p>
                    </div>
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        )}

        <div>
          <div>
            <button type="button" aria-label="Ajouter une pièce jointe">
              +
            </button>
            <input
              type="text"
              placeholder={`Envoyer un message dans #${channel.name}`}
              aria-label={`Envoyer un message dans ${channel.name}`}
            />
            <button type="button" aria-label="Envoyer le message">
              <Send width={18} height={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChannelView;
