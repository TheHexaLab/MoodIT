import React, { useState } from 'react';
import styles from './CourseChannelList.module.css';
import { ChannelTypeIcon } from './ChannelTypeIcon';
import { uiTypeDefinitions } from './channelTypeDefinitions.ts';
import { Edit } from '../../assets/Edit.tsx';
import {
  type ChannelMessage,
  type CourseChannel,
  type User,
  type VoicePresenceParticipant,
} from '../../types/domain.ts';

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

/**
 * Deux references designent-elles le meme canal ? Petit helper co-localise avec le type
 * `ChannelRef`. L'export d'une fonction depuis un fichier de composant degrade seulement le
 * fast-refresh en DEV (aucun impact prod) — assume.
 */
// eslint-disable-next-line react-refresh/only-export-components
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
  /** Présence vocale par canal (channelId → participants) : affichée sous les salons vocaux. */
  voicePresence?: Record<number, VoicePresenceParticipant[]>;
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
  typeDefinitions = uiTypeDefinitions(),
  voicePresence,
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

  /** Ligne cliquable d'un canal (sélection + ouverture) ; `trailing` : contenu en fin de ligne. */
  function channelButton(
    channel: CourseChannel,
    className: string,
    activeClassName: string,
    trailing?: React.ReactNode
  ) {
    const isSelected = isSameChannel(selectedChannel, channel);
    return (
      <button
        type="button"
        className={`${className} ${isSelected ? activeClassName : ''}`}
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
        {trailing}
      </button>
    );
  }

  return (
    <div className={styles.channelSections}>
      {/* Canal d'annonces : en tête, hors sections (un seul par cours, rien à éditer). */}
      {(channelsByType.announcement ?? []).map((channel) => (
        <div key={`announcement-${channel.id}`} className={styles.announcementItem}>
          {channelButton(channel, styles.announcementButton, styles.announcementButtonActive)}
        </div>
      ))}

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
                  // Présence vocale : participants connectés à ce salon (vide pour les autres types).
                  const present =
                    channel.type === 'voice' ? (voicePresence?.[channel.id] ?? []) : [];
                  return (
                    <li key={channel.id} className={styles.channelItem}>
                      {channelButton(
                        channel,
                        styles.channelButton,
                        styles.channelButtonActive,
                        present.length > 0 && (
                          <span className={styles.voiceCount} aria-label={`${present.length} connecté(s)`}>
                            {present.length}
                          </span>
                        )
                      )}

                      {present.length > 0 && (
                        <ul className={styles.voiceParticipants} role="list">
                          {present.map((p) => (
                            <li key={p.id} className={styles.voiceParticipant}>
                              <span className={styles.voiceDot} aria-hidden="true" />
                              <span className={styles.voiceParticipantName}>{p.name}</span>
                            </li>
                          ))}
                        </ul>
                      )}
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
