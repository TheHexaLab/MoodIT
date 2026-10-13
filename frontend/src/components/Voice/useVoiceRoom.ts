import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type LocalParticipant,
  type RemoteTrack,
  type RemoteParticipant,
  type VideoTrack,
} from 'livekit-client';
import { getVoiceToken } from '../../services/voiceApi';
import { createE2EESession, E2EE_TOPIC, type E2EESession } from './e2ee/e2eeSetup';
import { ensureDevice, type CurrentDevice } from './e2ee/deviceStore';
import { E2EEKeyExchange, type PeerKeyStatus } from './e2ee/E2EEKeyExchange';
import { getDevice } from './e2ee/keyDirectory';
import { encodeMessage } from './e2ee/protocol';
import { safetyCode } from './e2ee/safetyCode';
import { checkTrust, markVerified, type TrustLevel } from './e2ee/trustStore';

/** État de connexion au salon vocal. */
export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Vue d'un participant pour l'UI (dérivée de l'état LiveKit). */
export interface VoiceParticipant {
  identity: string;
  name: string;
  isLocal: boolean;
  /** Parle en ce moment (ActiveSpeakers de LiveKit). */
  isSpeaking: boolean;
  /** Micro coupé. */
  isMuted: boolean;
  /** Distants uniquement : avons-nous sa clé média (vérifiée) pour l'entendre ? */
  keyStatus?: PeerKeyStatus;
  /** Distants acceptés uniquement : confiance locale dans son appareil (TOFU / vérifié). */
  trust?: TrustLevel;
  /** Caméra visible (publiée, non coupée, et reçue pour un distant). Chiffrée E2EE comme l'audio. */
  camera?: VideoTrack;
  /** Partage d'écran visible (mêmes conditions que la caméra). */
  screen?: VideoTrack;
}

export interface UseVoiceRoom {
  status: VoiceStatus;
  participants: VoiceParticipant[];
  error: string | null;
  /** true pendant qu'une bascule micro est en cours (désactive le bouton). */
  micBusy: boolean;
  /** Nos trames sortantes sont chiffrées de bout en bout (E2EE actif côté SDK). */
  e2ee: boolean;
  join: () => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => Promise<void>;
  /** Code de sécurité entre NOTRE appareil et celui d'un participant (null si non vérifiable). */
  safetyCodeWith: (identity: string) => Promise<string | null>;
  /** Marque l'appareil d'un participant comme vérifié (après comparaison des codes). */
  verifyParticipant: (identity: string) => Promise<void>;
  /** true pendant une bascule caméra / partage d'écran (désactive les boutons). */
  videoBusy: boolean;
  /** Le navigateur sait partager l'écran (absent sur mobile). */
  canShareScreen: boolean;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
}

/** Piste vidéo affichable d'une source : publiée, non coupée, et effectivement reçue. */
function visibleVideo(p: Participant, source: Track.Source): VideoTrack | undefined {
  const pub = p.getTrackPublication(source);
  const track = pub && !pub.isMuted ? pub.videoTrack : undefined;
  // Un flux TERMINÉ (ex. « Arrêter le partage » natif du navigateur) n'affiche plus qu'un carré
  // noir : on ne le montre jamais, même si l'évènement de dépublication n'est pas encore arrivé.
  return track && track.mediaStreamTrack?.readyState !== 'ended' ? track : undefined;
}

/** getDisplayMedia absent (mobile, vieux navigateurs) → pas de bouton de partage d'écran. */
const CAN_SHARE_SCREEN =
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/** Projette l'état courant du Room LiveKit en liste de participants pour l'UI. */
function snapshot(room: Room, keys: E2EEKeyExchange | null): VoiceParticipant[] {
  const toModel = (p: Participant, isLocal: boolean): VoiceParticipant => ({
    identity: p.identity,
    name: p.name || p.identity,
    isLocal,
    isSpeaking: p.isSpeaking,
    isMuted: isLocal
      ? !(p as LocalParticipant).isMicrophoneEnabled
      : (p.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true),
    keyStatus: isLocal ? undefined : keys?.status(p.identity),
    trust: isLocal ? undefined : keys?.peerInfo(p.identity)?.trust,
    camera: visibleVideo(p, Track.Source.Camera),
    screen: visibleVideo(p, Track.Source.ScreenShare),
  });
  return [
    toModel(room.localParticipant, true),
    ...Array.from(room.remoteParticipants.values()).map((p) => toModel(p, false)),
  ];
}

/**
 * Pilote UNE connexion vocale LiveKit pour un canal. Récupère un JoinToken, se connecte au
 * SFU, publie le micro, lit les flux des autres et expose la présence (qui est là, qui parle,
 * qui est mute). Le mixage/décodage audio est fait par le navigateur + le SDK (doc section 6) :
 * on ne gère ici que la connexion et l'UI.
 */
export function useVoiceRoom(channelId: number): UseVoiceRoom {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [participants, setParticipants] = useState<VoiceParticipant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micBusy, setMicBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [e2ee, setE2ee] = useState(false);

  const roomRef = useRef<Room | null>(null);
  /** Worker + KeyProvider E2EE de la connexion en cours. */
  const e2eeRef = useRef<E2EESession | null>(null);
  /** Échange de clés de la connexion en cours (annonces, enveloppes, rotations). */
  const keysRef = useRef<E2EEKeyExchange | null>(null);
  /** Notre appareil pour la connexion en cours (clé publique → codes de sécurité). */
  const deviceRef = useRef<CurrentDevice | null>(null);
  /** Éléments <audio> créés pour lire les flux distants (détachés à la fermeture). */
  const audioElsRef = useRef<HTMLAudioElement[]>([]);
  /** Micro en cours de PUBLICATION initiale (join) : désactive brièvement le bouton le temps
   *  que la piste soit live. NE sert PAS aux bascules mute/unmute (voir desiredMicOnRef). */
  const micBusyRef = useRef(false);
  /** Dernière intention mute/unmute voulue par l'utilisateur. Permet de coalescer des clics
   *  rapprochés (dernier clic gagne) sans jamais en perdre, et d'éviter qu'un `await` plus
   *  ancien, qui se termine après un clic plus récent, n'écrase l'UI avec un état périmé. */
  const desiredMicOnRef = useRef<boolean | null>(null);

  const cleanup = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      room.removeAllListeners();
      await room.disconnect();
    }
    audioElsRef.current.forEach((el) => el.remove());
    audioElsRef.current = [];
    keysRef.current?.dispose();
    keysRef.current = null;
    e2eeRef.current?.worker.terminate();
    e2eeRef.current = null;
    setE2ee(false);
  }, []);

  const join = useCallback(async () => {
    if (roomRef.current) return; // déjà connecté/en cours
    setStatus('connecting');
    setError(null);
    try {
      // E2EE OBLIGATOIRE (E2EE.md §8), préparé AVANT tout appel réseau : navigateur incapable de
      // chiffrer → on refuse de rejoindre (jamais de repli en clair). Option `e2ee` (dépréciée)
      // VOLONTAIRE : la nouvelle option `encryption` chiffre aussi le data channel avec les clés
      // média, ce qui bloquerait l'échange de clés (validé au spike E0 : encryptionType 0).
      const e2eeSession = createE2EESession();
      e2eeRef.current = e2eeSession;
      // Appareil (clés d'identité locales + annuaire) : son id fait partie de l'identité LiveKit.
      const device = await ensureDevice();
      deviceRef.current = device;
      const { token, url, room: roomName } = await getVoiceToken(channelId, device.deviceId);
      const room = new Room({
        e2ee: { keyProvider: e2eeSession.keyProvider, worker: e2eeSession.worker },
        // Vidéo : ne reçoit que la qualité utile à la taille d'affichage (adaptiveStream) et
        // n'émet pas les couches simulcast que personne ne regarde (dynacast). Compatible E2EE :
        // le SFU choisit les couches sur les en-têtes RTP, sans lire le contenu chiffré.
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      const refresh = () => setParticipants(snapshot(room, keysRef.current));
      const keys = new E2EEKeyExchange({
        room: roomName,
        device,
        send: (msg, to) =>
          void room.localParticipant
            .publishData(encodeMessage(msg), {
              reliable: true,
              topic: E2EE_TOPIC,
              destinationIdentities: to,
            })
            .catch((e: unknown) => console.warn('[e2ee] envoi impossible', e)),
        lookup: getDevice,
        // TOFU propre au compte connecté localement (IndexedDB, trustStore).
        trust: (peer) => checkTrust(device.userId, peer),
        setMediaKey: (identity, raw, index) =>
          e2eeSession.keyProvider.setParticipantKey(identity, raw, index),
        onChange: () => {
          if (roomRef.current === room) refresh();
        },
      });
      keysRef.current = keys;

      // Pré-chauffe DNS/TLS/ICE pendant qu'on attache les écouteurs : une partie de la
      // négociation est faite d'avance, donc room.connect() plus bas rend la main plus vite.
      room.prepareConnection(url, token);

      // Un flux audio distant arrive : on l'attache à un <audio> caché pour l'ENTENDRE.
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach() as HTMLAudioElement;
          el.style.display = 'none';
          document.body.appendChild(el);
          audioElsRef.current.push(el);
        }
        refresh();
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => {
          el.remove();
          audioElsRef.current = audioElsRef.current.filter((e) => e !== el);
        });
        refresh();
      });

      // Tout ce qui change la liste ou l'état visuel des participants → re-rendu.
      room.on(RoomEvent.ParticipantConnected, refresh);
      room.on(RoomEvent.ParticipantDisconnected, refresh);
      room.on(RoomEvent.TrackMuted, refresh);
      room.on(RoomEvent.TrackUnmuted, refresh);
      room.on(RoomEvent.ActiveSpeakersChanged, refresh);
      room.on(RoomEvent.LocalTrackPublished, refresh);
      room.on(RoomEvent.LocalTrackUnpublished, refresh);
      // Un AUTRE participant publie / retire une piste (caméra coupée, partage arrêté, y compris par
      // la barre native du navigateur) : sans ça, sa tuile restait un carré noir jusqu'au prochain
      // évènement quelconque.
      room.on(RoomEvent.TrackPublished, refresh);
      room.on(RoomEvent.TrackUnpublished, refresh);
      // Échange de clés : arrivées/départs et messages du topic E2EE. L'émetteur est l'identité
      // attestée par le SFU (participant.identity), jamais un champ du message lui-même.
      room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => keys.peerJoined(p.identity));
      room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => keys.peerLeft(p.identity));
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic === E2EE_TOPIC && participant) keys.handleMessage(payload, participant.identity);
      });

      room.on(RoomEvent.ParticipantEncryptionStatusChanged, (enabled, participant) => {
        if (!participant || participant.isLocal) setE2ee(enabled);
      });
      // Les premières trames d'un pair (ou celles d'une rotation) précèdent parfois sa clé :
      // quelques échecs sont normaux. On n'alerte que si ça PERSISTE sans clé reçue.
      const firstFailure = new Map<string, number>();
      room.on(RoomEvent.EncryptionError, (err, participant) => {
        const who = participant?.identity ?? '?';
        const now = Date.now();
        const since = firstFailure.get(who) ?? now;
        firstFailure.set(who, since);
        console.warn('[e2ee] échec de (dé)chiffrement', who, err.message);
        if (now - since > 5000 && roomRef.current === room && keys.status(who) !== 'ready') {
          setError(`Audio de ${participant?.name || who} indéchiffrable (clé non reçue).`);
        }
      });
      await room.setE2EEEnabled(true);

      // Déconnexion subie (serveur coupe, réseau) : on remet l'UI au propre.
      room.on(RoomEvent.Disconnected, () => {
        void cleanup();
        setStatus('idle');
        setParticipants([]);
      });

      // On est "dans le salon" dès que connect() rend la main (~300ms : on entend déjà les
      // autres). On NE bloque PAS cet état sur la publication du micro : publier déclenche une
      // renégociation WebRTC qui prend ~1-2s (ICE), et attendre dessus donnait une UI figée sur
      // « Connexion… » alors qu'on était déjà connecté.
      await room.connect(url, token);

      // Première clé posée et annonce diffusée AVANT de publier le micro : aucune trame ne part
      // sans clé.
      await keys.start(room.localParticipant.identity);

      setStatus('connected');
      refresh();

      // Publication du micro EN TÂCHE DE FOND. Le bouton micro reste désactivé (micBusy) le temps
      // de la renégociation, puis est réactivé. Échec (permission refusée, périphérique occupé) =
      // NON fatal : on reste connecté, micro coupé. Les gardes `roomRef.current === room` évitent
      // d'écrire dans l'UI si l'utilisateur a quitté pendant la publication.
      micBusyRef.current = true;
      setMicBusy(true);
      void room.localParticipant
        .setMicrophoneEnabled(true)
        .then(() => {
          if (roomRef.current === room) refresh();
        })
        .catch(() => {
          if (roomRef.current === room) setError('Micro indisponible — connecté, micro coupé.');
        })
        .finally(() => {
          if (roomRef.current === room) {
            micBusyRef.current = false;
            setMicBusy(false);
          }
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connexion vocale impossible');
      setStatus('error');
      await cleanup();
    }
  }, [channelId, cleanup]);

  const leave = useCallback(async () => {
    await cleanup();
    setStatus('idle');
    setParticipants([]);
  }, [cleanup]);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;

    // État courant = la dernière intention en vol si une bascule tourne, sinon l'état réel LiveKit.
    // On ne LÂCHE PAS le clic même si une bascule est en cours (l'ancien garde « micBusy » perdait
    // les clics rapprochés → bouton qui semblait lent/sans effet) : on enregistre la nouvelle
    // intention et on relance. setMicrophoneEnabled est sérialisé en interne par le SDK (muteLock),
    // donc des appels successifs convergent dans l'ordre.
    const current = desiredMicOnRef.current ?? room.localParticipant.isMicrophoneEnabled;
    const target = !current;
    desiredMicOnRef.current = target;

    // Bascule OPTIMISTE : l'UI reflète l'intention IMMÉDIATEMENT (pas d'attente du round-trip).
    setParticipants((prev) =>
      prev.map((p) => (p.isLocal ? { ...p, isMuted: !target } : p))
    );

    try {
      await room.localParticipant.setMicrophoneEnabled(target);
    } catch {
      // Échec (périphérique occupé, etc.) : on resynchronise ci-dessous sur l'état réel.
    } finally {
      // Ne resynchronise QUE si cette bascule est la plus récente : sinon un await plus ancien
      // écraserait l'UI avec un état périmé (un clic plus récent est déjà en cours).
      if (desiredMicOnRef.current === target) {
        desiredMicOnRef.current = null;
        if (roomRef.current === room) setParticipants(snapshot(room, keysRef.current));
      }
    }
  }, []);

  // Démontage du composant : on coupe proprement la connexion (sinon micro reste actif).
  useEffect(() => () => void cleanup(), [cleanup]);

  const safetyCodeWith = useCallback(async (identity: string) => {
    const peer = keysRef.current?.peerInfo(identity);
    const me = deviceRef.current;
    return peer && me ? safetyCode(me.pub.signPub, peer.signPub) : null;
  }, []);

  /**
   * Bascule caméra / partage d'écran. Les pistes sont chiffrées E2EE comme le micro (le SDK chiffre
   * TOUTES les pistes publiées avec notre clé média) : rien de spécifique à la vidéo ici. Échec
   * (permission refusée, périphérique occupé) = non fatal ; annuler le sélecteur d'écran = silencieux.
   */
  const toggleVideo = useCallback(async (source: 'camera' | 'screen') => {
    const room = roomRef.current;
    if (!room) return;
    const lp = room.localParticipant;
    setVideoBusy(true);
    try {
      if (source === 'camera') {
        await lp.setCameraEnabled(!lp.isCameraEnabled);
      } else {
        // audio: true → partage aussi le son de l'onglet / de l'écran quand le navigateur le permet.
        await lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true });
      }
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === 'NotAllowedError' && source === 'screen';
      if (!cancelled && roomRef.current === room) {
        setError(source === 'camera' ? 'Caméra indisponible.' : "Partage d'écran impossible.");
      }
    } finally {
      if (roomRef.current === room) {
        setVideoBusy(false);
        setParticipants(snapshot(room, keysRef.current));
      }
    }
  }, []);

  const toggleCamera = useCallback(() => toggleVideo('camera'), [toggleVideo]);
  const toggleScreenShare = useCallback(() => toggleVideo('screen'), [toggleVideo]);

  const verifyParticipant = useCallback(async (identity: string) => {
    const keys = keysRef.current;
    const peer = keys?.peerInfo(identity);
    const me = deviceRef.current;
    if (!keys || !peer || !me) return;
    await markVerified(me.userId, peer.deviceId);
    keys.markVerified(identity);
  }, []);

  return {
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
    canShareScreen: CAN_SHARE_SCREEN,
    toggleCamera,
    toggleScreenShare,
  };
}
