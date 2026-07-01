import React, { useState } from 'react';
import styles from './CourseChannelList.module.css';
import { ChannelTypeIcon } from './ChannelTypeIcon';
import { defaultTypeDefinitions } from './channelTypeDefinitions.ts';
import { Edit } from '../../assets/Edit.tsx';
import { type ChannelMessage, type CourseChannel, type User } from '../../types/domain.ts';

// Entités ré-exportées depuis le modèle de domaine (source unique : src/types/domain.ts).
export type { ChannelMessage, CourseChannel };
/** Auteur d'un message = User (mêmes colonnes que User_). Alias de compat. */
export type ChannelMessageAuthor = User;

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
  /**
   * Callback d'édition d'une section (icône crayon a droite de l'en-tête).
   * On edite la section entiere (sa liste de canaux), pas un canal isole.
   * Si absent, l'icône d'édition n'est pas rendue.
   */
  onEditSection?: (section: ChannelTypeDefinition) => void;
}

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
  onEditSection,
}) => {
  /** Types de sections actuellement repliés (etat local, non persiste). */
  const [collapsedTypes, setCollapsedTypes] = useState<Record<string, boolean>>({});

  function toggleCollapsed(type: string) {
    setCollapsedTypes((prev) => ({ ...prev, [type]: !prev[type] }));
  }

  const channelsByType = channels.reduce<Record<string, CourseChannel[]>>((acc, channel) => {
    if (!acc[channel.type]) acc[channel.type] = [];
    acc[channel.type].push(channel);
    return acc;
  }, {});

  return (
    <div className={styles.channelSections}>
      {typeDefinitions.map((definition) => {
        const typedChannels = channelsByType[definition.type] ?? [];
        const isCollapsed = collapsedTypes[definition.type] ?? false;

        return (
          <section
            key={definition.type}
            className={styles.channelSection}
            aria-label={definition.label}
          >
            <header className={styles.sectionHeader}>
              <button
                type="button"
                className={styles.sectionToggle}
                onClick={() => toggleCollapsed(definition.type)}
                aria-expanded={!isCollapsed}
              >
                <svg
                  className={`${styles.sectionChevron} ${isCollapsed ? styles.sectionChevronCollapsed : ''}`}
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
              </button>

              {onEditSection && (
                <button
                  type="button"
                  className={styles.sectionEdit}
                  onClick={() => onEditSection(definition)}
                  aria-label={`Modifier la section ${definition.label}`}
                  title={`Modifier la section ${definition.label}`}
                >
                  <Edit width="14" height="14" aria-hidden="true" />
                </button>
              )}
            </header>

            {isCollapsed ? null : typedChannels.length > 0 ? (
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
                        <span className={styles.channelPrefix}>
                          <ChannelTypeIcon type={channel.type} />
                        </span>
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
