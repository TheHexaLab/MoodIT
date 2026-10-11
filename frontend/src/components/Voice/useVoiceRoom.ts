import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type LocalParticipant,
  type RemoteTrack,
} from 'livekit-client';
import { getVoiceToken } from '../../services/voiceApi';

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
}

export interface UseVoiceRoom {
  status: VoiceStatus;
  participants: VoiceParticipant[];
  error: string | null;
  /** true pendant qu'une bascule micro est en cours (désactive le bouton). */
  micBusy: boolean;
  join: () => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => Promise<void>;
}

/** Projette l'état courant du Room LiveKit en liste de participants pour l'UI. */
function snapshot(room: Room): VoiceParticipant[] {
  const toModel = (p: Participant, isLocal: boolean): VoiceParticipant => ({
    identity: p.identity,
    name: p.name || p.identity,
    isLocal,
    isSpeaking: p.isSpeaking,
    isMuted: isLocal
      ? !(p as LocalParticipant).isMicrophoneEnabled
      : (p.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true),
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

  const roomRef = useRef<Room | null>(null);
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
  }, []);

  const join = useCallback(async () => {
    if (roomRef.current) return; // déjà connecté/en cours
    setStatus('connecting');
    setError(null);
    try {
      const { token, url } = await getVoiceToken(channelId);
      const room = new Room();
      roomRef.current = room;

      // Pré-chauffe DNS/TLS/ICE pendant qu'on attache les écouteurs : une partie de la
      // négociation est faite d'avance, donc room.connect() plus bas rend la main plus vite.
      room.prepareConnection(url, token);

      const refresh = () => setParticipants(snapshot(room));

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
        if (roomRef.current === room) setParticipants(snapshot(room));
      }
    }
  }, []);

  // Démontage du composant : on coupe proprement la connexion (sinon micro reste actif).
  useEffect(() => () => void cleanup(), [cleanup]);

  return { status, participants, error, micBusy, join, leave, toggleMute };
}
