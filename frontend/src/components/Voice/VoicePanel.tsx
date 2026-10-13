import React, { useEffect, useState } from 'react';
import styles from './VoicePanel.module.css';
import { MyDevices } from './MyDevices';
import { VideoTile } from './VideoTile';
import { useVoiceRoom, type VoiceParticipant } from './useVoiceRoom';

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
  const {
    status,
    participants,
    error,
    micBusy,
    e2ee,
    join,
    leave,
    toggleMute,
    safetyCodeWith,
    verifyParticipant,
    videoBusy,
    canShareScreen,
    toggleCamera,
    toggleScreenShare,
  } = useVoiceRoom(channelId);
  const screens = participants.filter((p) => p.screen);
  const cameras = participants.filter((p) => p.camera);
  const connected = status === 'connected';
  const self = participants.find((p) => p.isLocal);

  /** Vérification en cours : participant + son code de sécurité avec NOTRE appareil. */
  const [checking, setChecking] = useState<{ identity: string; name: string; code: string } | null>(
    null
  );
  const [showDevices, setShowDevices] = useState(false);

  const openCheck = async (p: VoiceParticipant) => {
    const code = await safetyCodeWith(p.identity);
    if (code) setChecking({ identity: p.identity, name: p.name, code });
  };
  // Le participant vérifié a quitté le salon : on ferme le panneau de vérification.
  const checkingGone = checking && !participants.some((p) => p.identity === checking.identity);

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
            <button
              type="button"
              className={styles.mute}
              onClick={() => void toggleCamera()}
              disabled={videoBusy}
              aria-pressed={Boolean(self?.camera)}
            >
              {self?.camera ? '📷 Couper la caméra' : '📷 Activer la caméra'}
            </button>
            {canShareScreen && (
              <button
                type="button"
                className={styles.mute}
                onClick={() => void toggleScreenShare()}
                disabled={videoBusy}
                aria-pressed={Boolean(self?.screen)}
              >
                {self?.screen ? "🖥️ Arrêter le partage" : "🖥️ Partager l'écran"}
              </button>
            )}
            <button type="button" className={styles.leave} onClick={() => void leave()}>
              Quitter
            </button>
          </>
        )}
      </div>

      {connected && e2ee && <p className={styles.e2ee}>🔒 Chiffré de bout en bout</p>}

      {connected && (screens.length > 0 || cameras.length > 0) && (
        <div className={styles.videoGrid}>
          {/* Partages d'écran d'abord, en grand : c'est ce qu'on regarde en cours. */}
          {screens.map((p) => (
            <VideoTile
              key={`${p.identity}:screen`}
              track={p.screen!}
              label={`Écran de ${p.name}${p.isLocal ? ' (moi)' : ''}`}
              screen
            />
          ))}
          {cameras.map((p) => (
            <VideoTile
              key={`${p.identity}:camera`}
              track={p.camera!}
              label={`${p.name}${p.isLocal ? ' (moi)' : ''}`}
              mirrored={p.isLocal}
            />
          ))}
        </div>
      )}

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
              {p.keyStatus === 'pending' && (
                <span className={styles.mutedTag} title="Échange de clés en cours">
                  ⏳ clé
                </span>
              )}
              {p.keyStatus === 'rejected' && (
                <span
                  className={styles.keyRejected}
                  title="Clés d'appareil invalides ou révoquées : son audio n'est pas déchiffré"
                >
                  ⚠ appareil refusé
                </span>
              )}
              {p.keyStatus === 'keyChanged' && (
                <span
                  className={styles.keyRejected}
                  title="Cet appareil se présente avec une AUTRE clé que celle déjà vue : possible interception. Son audio n'est pas déchiffré."
                >
                  ⚠ clé changée
                </span>
              )}
              {p.trust === 'verified' && (
                <span className={styles.verifiedTag} title="Code de sécurité vérifié">
                  ✔ vérifié
                </span>
              )}
              {p.trust === 'new' && (
                <span className={styles.mutedTag} title="Premier appel avec cet appareil">
                  nouvel appareil
                </span>
              )}
              {!p.isLocal && p.trust && p.trust !== 'verified' && (
                <button type="button" className={styles.linkButton} onClick={() => void openCheck(p)}>
                  Vérifier
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {connected && checking && !checkingGone && (
        <section className={styles.safety} aria-label="Code de sécurité">
          <p>
            Comparez ce code avec <strong>{checking.name}</strong> (de vive voix ou en personne, pas
            par écrit dans MoodIT). S'il est identique sur vos deux écrans, personne ne s'est
            interposé entre vos appareils.
          </p>
          <code className={styles.safetyCode} data-testid="safety-code">
            {checking.code}
          </code>
          <div className={styles.bar}>
            <button
              type="button"
              className={styles.join}
              onClick={() =>
                void verifyParticipant(checking.identity).then(() => setChecking(null))
              }
            >
              Les codes correspondent
            </button>
            <button type="button" className={styles.mute} onClick={() => setChecking(null)}>
              Fermer
            </button>
          </div>
        </section>
      )}

      <button
        type="button"
        className={styles.linkButton}
        aria-expanded={showDevices}
        onClick={() => setShowDevices((v) => !v)}
      >
        {showDevices ? 'Masquer mes appareils' : 'Mes appareils'}
      </button>
      {showDevices && <MyDevices />}
    </div>
  );
};

export default VoicePanel;
