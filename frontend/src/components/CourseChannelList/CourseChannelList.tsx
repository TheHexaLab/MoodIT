import React from 'react';
import styles from './CourseChannelList.module.css';
import { getPrefixForType } from './channelTypePrefix';

/** Auteur d'un message (≈ colonnes utiles de User_). */
export interface ChannelMessageAuthor {
  /** User_.id */
  id: number;
  /** User_.username */
  username: string;
  /** User_.first_name */
  first_name: string;
  /** User_.last_name */
  last_name: string;
  /** User_.avatar_color (ex. '#0a5cc0'). */
  avatar_color?: string;
}

/** Message d'un canal de discussion (≈ Post d'un Forum de f_type 'Discussion'). */
export interface ChannelMessage {
  /** Post.id */
  id: number;
  /** Post.content */
  content: string;
  /** Post.created_at (timestamp ISO). */
  created_at: string;
  /** Auteur du message. */
  author: ChannelMessageAuthor;
}

export interface CourseChannel {
  /** Identifiant du canal/forum/quiz (SERIAL). */
  id: number;
  /** Nom affiche dans la liste. */
  name: string;
  /** Type logique du canal (quiz, text, forum, etc.). */
  type: string;
  /** Messages du canal (uniquement pour un canal de discussion). */
  messages?: ChannelMessage[];
}

/**
 * Reference unique d'un canal dans la liste fusionnee.
 * Quiz et Forum ont des id_ SERIAL independants (un quiz et un forum peuvent
 * tous deux avoir id=1) : il faut donc le type ET l'id pour identifier une ligne.
 */
export interface ChannelRef {
  id: number;
  type: string;
}

/** Deux references designent-elles le meme canal ? */
export function isSameChannel(
  a: ChannelRef | null | undefined,
  b: ChannelRef | null | undefined
): boolean {
  return a != null && b != null && a.id === b.id && a.type === b.type;
}

export interface ChannelTypeDefinition {
  /** Identifiant stable du type. */
  type: string;
  /** Libelle affiche dans l'en-tête de section. */
  label: string;
  /** Message affiche quand la section ne contient aucun canal. */
  emptyLabel: string;
}

interface CourseChannelListProps {
  /** Canaux du cours sélectionné. */
  channels?: CourseChannel[];
  /** Types supportés par défaut, extensibles par le parent. */
  typeDefinitions?: ChannelTypeDefinition[];
  /** Canal actuellement sélectionné (type + id : les id_ se chevauchent entre quiz/forum). */
  selectedChannel?: ChannelRef;
  /** Callback de sélection d'un canal. */
  onSelectChannel?: (channel: ChannelRef) => void;
  /**
   * Callback d'ouverture d'un canal (vue a implementer).
   * Déclenché en même temps que la selection — distinct pour permettre
   * une navigation ou un rendu indépendant de l'état visuel.
   */
  onOpenChannel?: (channel: CourseChannel) => void;
}

const defaultTypeDefinitions: ChannelTypeDefinition[] = [
  { type: 'quiz', label: 'QUIZ', emptyLabel: 'Aucun quiz' },
  { type: 'text', label: 'CANAUX', emptyLabel: 'Aucun canal' },
  { type: 'forum', label: 'FORUMS', emptyLabel: 'Aucun forum' },
];

/**
 * Liste les canaux regroupés par type pour le cours actif.
 * Les types quiz, text et forum sont fournis par défaut, mais le parent
 * peut injecter des types supplémentaires via `typeDefinitions`.
 */
const CourseChannelList: React.FC<CourseChannelListProps> = ({
  channels = [],
  typeDefinitions = defaultTypeDefinitions,
  selectedChannel,
  onSelectChannel,
  onOpenChannel,
}) => {
  const channelsByType = channels.reduce<Record<string, CourseChannel[]>>((acc, channel) => {
    if (!acc[channel.type]) acc[channel.type] = [];
    acc[channel.type].push(channel);
    return acc;
  }, {});

  return (
    <div className={styles.channelSections}>
      {typeDefinitions.map((definition) => {
        const typedChannels = channelsByType[definition.type] ?? [];

        return (
          <section
            key={definition.type}
            className={styles.channelSection}
            aria-label={definition.label}
          >
            <header className={styles.sectionHeader}>
              <svg
                className={styles.sectionChevron}
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M3 4.5 6 7.5 9 4.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{definition.label}</span>
            </header>

            {typedChannels.length > 0 ? (
              <ul className={styles.channelList} role="list">
                {typedChannels.map((channel) => {
                  const isSelected = isSameChannel(selectedChannel, channel);
                  return (
                    <li key={channel.id} className={styles.channelItem}>
                      <button
                        type="button"
                        className={`${styles.channelButton} ${isSelected ? styles.channelButtonActive : ''}`}
                        onClick={() => {
                          onSelectChannel?.({ id: channel.id, type: channel.type });
                          onOpenChannel?.(channel);
                        }}
                        aria-current={isSelected ? 'page' : undefined}
                      >
                        <span className={styles.channelPrefix}>{getPrefixForType(channel.type)}</span>
                        <span className={styles.channelName}>{channel.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.emptyLabel}>{definition.emptyLabel}</p>
            )}
          </section>
        );
      })}
    </div>
  );
};


export default CourseChannelList;
