import React, { useEffect, useRef } from 'react';
import { type VideoTrack } from 'livekit-client';
import styles from './VoicePanel.module.css';

interface VideoTileProps {
  track: VideoTrack;
  /** Nom affiché en surimpression. */
  label: string;
  /** Notre propre caméra : affichée en miroir (comme un miroir, plus naturel). */
  mirrored?: boolean;
  /** Partage d'écran : tuile large, image entière (pas de recadrage). */
  screen?: boolean;
}

/**
 * Affiche une piste vidéo LiveKit (caméra ou écran). La piste est déjà DÉCHIFFRÉE par le worker
 * E2EE : on ne fait que l'attacher à un <video>. attach/detach suivent le cycle de vie React, et
 * l'élément attaché permet à adaptiveStream de ne recevoir que la qualité utile à sa taille.
 */
export const VideoTile: React.FC<VideoTileProps> = ({ track, label, mirrored, screen }) => {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <figure className={screen ? styles.screenTile : styles.videoTile} data-testid="video-tile">
      <video
        ref={ref}
        className={mirrored ? styles.mirrored : undefined}
        autoPlay
        playsInline
        muted
        aria-label={label}
      />
      <figcaption className={styles.videoLabel}>{label}</figcaption>
    </figure>
  );
};

export default VideoTile;
