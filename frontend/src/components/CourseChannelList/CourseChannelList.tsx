import React from 'react';
import styles from './CourseChannelList.module.css';
import { getPrefixForType } from './channelTypePrefix';

export interface CourseChannel {
  id: string;
  /** Nom affiche dans la liste. */
  name: string;
  /** Type logique du canal (quiz, text, forum, etc.). */
  type: string;
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
  /** Canal actuellement sélectionné. */
  selectedChannelId?: string;
  /** Callback de sélection d'un canal. */
  onSelectChannel?: (channelId: string) => void;
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
  selectedChannelId,
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
                {typedChannels.map((channel) => (
                  <li key={channel.id} className={styles.channelItem}>
                    <button
                      type="button"
                      className={`${styles.channelButton} ${selectedChannelId === channel.id ? styles.channelButtonActive : ''}`}
                      onClick={() => {
                        onSelectChannel?.(channel.id);
                        onOpenChannel?.(channel);
                      }}
                      aria-current={selectedChannelId === channel.id ? 'page' : undefined}
                    >
                      <span className={styles.channelPrefix}>{getPrefixForType(channel.type)}</span>
                      <span className={styles.channelName}>{channel.name}</span>
                    </button>
                  </li>
                ))}
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
