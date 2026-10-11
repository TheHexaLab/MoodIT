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
  /** Garde anti-chevauchement : empêche deux bascules micro concurrentes (clics rapprochés). */
  const micBusyRef = useRef(false);

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

      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setStatus('connected');
      refresh();
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
    // Ignore le clic si pas connecté, ou si une bascule est déjà en cours (anti-chevauchement :
    // setMicrophoneEnabled est async — deux appels concurrents se court-circuitaient, d'où des
    // clics « sans effet »). L'état réel est toujours relu de LiveKit en fin de bascule.
    if (!room || micBusyRef.current) return;
    micBusyRef.current = true;
    setMicBusy(true);
    try {
      await room.localParticipant.setMicrophoneEnabled(
        !room.localParticipant.isMicrophoneEnabled
      );
    } catch {
      // Échec (périphérique occupé, etc.) : on ne casse pas l'état, on resynchronise ci-dessous.
    } finally {
      micBusyRef.current = false;
      setMicBusy(false);
      setParticipants(snapshot(room));
    }
  }, []);

  // Démontage du composant : on coupe proprement la connexion (sinon micro reste actif).
  useEffect(() => () => void cleanup(), [cleanup]);

  return { status, participants, error, micBusy, join, leave, toggleMute };
}
