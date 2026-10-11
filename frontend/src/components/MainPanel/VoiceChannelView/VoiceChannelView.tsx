import React from 'react';
import styles from './VoiceChannelView.module.css';
import { type CourseChannel } from '../../../types/domain.ts';
import { type Course } from '../../CourseMenu/CourseMenu.tsx';
import { ChannelTypeIcon } from '../../CourseChannelList/ChannelTypeIcon.tsx';
import { VoicePanel } from '../../Voice/VoicePanel.tsx';

interface VoiceChannelViewProps {
  course: Course;
  /** Canal de type 'voice' (Forum de F_Type 'Voice'). */
  channel: CourseChannel;
  /** Annonce de présence (sidebar) ; transmise à VoicePanel. */
  onPresence?: (channelId: number, joined: boolean) => void;
}

/**
 * Vue d'un canal VOCAL. Contrairement à un canal de discussion, il n'y a pas de messages :
 * le contenu est la session audio, pilotée par VoicePanel (rejoindre / participants / mute).
 * Vue propre au type 'voice' — routée par MainPanel.
 */
const VoiceChannelView: React.FC<VoiceChannelViewProps> = ({ course, channel, onPresence }) => {
  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <p>
          <span>
            <ChannelTypeIcon type="voice" />
          </span>
          <span>{channel.name}</span>
        </p>
        <span />
        <p>{course.title}</p>
      </header>

      <div className={styles.body}>
        <VoicePanel channelId={channel.id} channelName={channel.name} onPresence={onPresence} />
      </div>
    </div>
  );
};

export default VoiceChannelView;
