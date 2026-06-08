import React from 'react';
import styles from './ChannelView.module.css';
import { type CourseChannel } from '../../CourseChannelList/CourseChannelList';
import { getPrefixForType } from '../../CourseChannelList/channelTypePrefix';
import { type Course } from '../../CourseMenu/CourseMenu';
import { getCourseDisplayLabel } from '../../CourseMenu/courseLabel';
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

/** Initiale affichee dans l'avatar. */
function getInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

/**
 * Etat 5 — vue d'un canal de discussion (f_type 'Discussion').
 * Echange libre facon chat : liste des messages + zone de saisie.
 */
const ChannelView: React.FC<ChannelViewProps> = ({ course, channel }: ChannelViewProps) => {
  const messages = channel.messages ?? [];
  const courseLabel = getCourseDisplayLabel(course);

  return (
    <div className={styles.channelView}>
      <header className={styles.header}>
        {courseLabel && <p className={styles.meta}>{courseLabel}</p>}
        <h1 className={styles.title}>
          <span className={styles.prefix}>{getPrefixForType(channel.type)}</span>
          {channel.name}
        </h1>
      </header>

      <div className={styles.body}>
        {messages.length === 0 ? (
          <p className={styles.placeholder}>Aucun message dans ce canal pour l'instant.</p>
        ) : (
          <ul className={styles.messageList}>
            {messages.map((message) => {
              const avatarColor = message.author.avatarColor ?? DEFAULT_AVATAR_COLOR;
              return (
                <li key={message.id} className={styles.message}>
                  <span
                    className={styles.avatar}
                    style={{ background: avatarColor, color: contrastingTextColor(avatarColor) }}
                    aria-hidden="true"
                  >
                    {getInitial(message.author.displayName)}
                  </span>
                  <div className={styles.messageBody}>
                    <p className={styles.messageHeader}>
                      <span className={styles.messageAuthor}>{message.author.displayName}</span>
                      <span className={styles.messageTime}>{formatTime(message.created_at)}</span>
                    </p>
                    <p className={styles.messageContent}>{message.content}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className={styles.composer}>
          <input
            className={styles.composerInput}
            type="text"
            placeholder={`Envoyer un message dans #${channel.name}`}
            aria-label={`Envoyer un message dans ${channel.name}`}
            disabled
          />
        </div>
      </div>
    </div>
  );
};

export default ChannelView;
