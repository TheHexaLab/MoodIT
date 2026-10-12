import React, { useEffect } from 'react';
import styles from './VoicePanel.module.css';
import { useVoiceRoom } from './useVoiceRoom';

interface VoicePanelProps {
  /** Canal dont on rejoint le salon vocal (room LiveKit "channel:<id>"). */
  channelId: number;
  channelName: string;
  /**
   * Annonce de présence (sidebar) : prévient le serveur que cette session entre/sort du salon.
   * Optionnel — sans lui, le vocal marche mais la présence n'apparaît pas pour les autres.
   */
  onPresence?: (channelId: number, joined: boolean) => void;
}

/**
 * Barre vocale d'un canal : rejoindre / quitter, liste des participants (indicateur « parle »),
 * mute de son micro. Volontairement auto-contenue — tout le vocal vit dans ce composant + son
 * hook, pour rester un greffon retirable.
 */
export const VoicePanel: React.FC<VoicePanelProps> = ({ channelId, channelName, onPresence }) => {
  const { status, participants, error, micBusy, join, leave, toggleMute } = useVoiceRoom(channelId);
  const connected = status === 'connected';
  const self = participants.find((p) => p.isLocal);

  // Présence sidebar : on s'annonce quand la connexion LiveKit est établie, et on se retire
  // quand elle se termine (quitter, déconnexion subie) ou au démontage du composant.
  useEffect(() => {
    if (!onPresence || !connected) return;
    onPresence(channelId, true);
    return () => onPresence(channelId, false);
  }, [connected, channelId, onPresence]);

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <span className={styles.title}>🔊 Vocal · {channelName}</span>

        {!connected ? (
          <button
            type="button"
            className={styles.join}
            onClick={() => void join()}
            disabled={status === 'connecting'}
          >
            {status === 'connecting' ? 'Connexion…' : 'Rejoindre le vocal'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={styles.mute}
              onClick={() => void toggleMute()}
              disabled={micBusy}
              aria-pressed={self?.isMuted ?? false}
            >
              {self?.isMuted ? '🔇 Activer le micro' : '🎙️ Couper le micro'}
            </button>
            <button type="button" className={styles.leave} onClick={() => void leave()}>
              Quitter
            </button>
          </>
        )}
      </div>

      {error && <p className={styles.error}>⚠ {error}</p>}

      {connected && (
        <ul className={styles.participants}>
          {participants.map((p) => (
            <li
              key={p.identity}
              className={styles.participant}
              data-speaking={p.isSpeaking ? '' : undefined}
            >
              <span className={styles.dot} />
              <span className={styles.name}>
                {p.name}
                {p.isLocal ? ' (moi)' : ''}
              </span>
              {p.isMuted && <span className={styles.mutedTag}>muet</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default VoicePanel;
