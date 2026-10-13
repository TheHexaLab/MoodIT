import { type CurrentDevice } from './deviceStore';
import { verifyPublicKeys } from './deviceCrypto';
import { type DeviceKeyRecord } from './keyDirectory';
import { type TrustLevel } from './trustStore';
import {
  ANNOUNCE_MAX_SKEW_MS,
  decodeMessage,
  deriveWrapKey,
  generateSessionKeys,
  keyIndexOf,
  parseIdentity,
  randomMediaKey,
  signAnnounce,
  unwrapMediaKey,
  verifyAnnounce,
  wrapMediaKey,
  type AnnounceMsg,
  type E2EEMessage,
  type KeyMsg,
  type SessionKeys,
} from './protocol';

/**
 * Échange de clés du vocal chiffré pour UNE connexion à un salon (voice-service/E2EE.md §5.5-5.6).
 * Sans React ni LiveKit : le transport, l'annuaire et le trousseau sont injectés, ce qui permet de
 * tester le protocole avec plusieurs participants simulés.
 *
 * Règles :
 *  - un pair n'est accepté qu'après vérification de son annonce : signature par la clé d'identité
 *    de SON appareil (annuaire), appareil non révoqué et appartenant bien au userId de l'identité ;
 *  - toute arrivée ou départ d'un pair vérifié → ROTATION : nouvelle clé média aléatoire, envoyée
 *    chiffrée à chaque pair présent, puis activée localement après un court délai (le temps que les
 *    autres la reçoivent). Un arrivant ne peut donc pas lire l'avant, un partant pas l'après.
 */

/** Envoi d'un message, en diffusion (to absent) ou vers des identités précises. */
export type SendMessage = (msg: E2EEMessage, to?: string[]) => void;
/** Lecture des clés publiques d'un appareil (GET /api/keys/devices/{id}). */
export type LookupDevice = (deviceId: string) => Promise<DeviceKeyRecord>;
/** Pose d'une clé média dans le trousseau LiveKit (MooditKeyProvider). */
export type SetMediaKey = (identity: string, rawKey: ArrayBuffer, keyIndex: number) => Promise<void>;

/**
 * État d'un pair : 'pending' (clé pas encore reçue), 'ready' (on l'entend), 'rejected' (appareil
 * invalide/révoqué), 'keyChanged' (même appareil, AUTRE clé que celle mémorisée : alerte TOFU).
 */
export type PeerKeyStatus = 'pending' | 'ready' | 'rejected' | 'keyChanged';

/** Confiance locale (TOFU) dans un appareil distant : cf. trustStore.checkTrust. */
export type CheckTrust = (peer: {
  deviceId: string;
  userId: number;
  signPub: string;
}) => Promise<TrustLevel>;

/** Ce que l'UI peut savoir d'un pair accepté (code de sécurité, badge de confiance). */
export interface PeerInfo {
  deviceId: string;
  userId: number;
  signPub: string;
  trust: TrustLevel;
}

export interface KeyExchangeOptions {
  room: string;
  device: CurrentDevice;
  send: SendMessage;
  lookup: LookupDevice;
  setMediaKey: SetMediaKey;
  /** Confiance TOFU ; par défaut tout appareil est « nouveau » (aucune mémoire). */
  trust?: CheckTrust;
  /** Un statut de pair a changé (re-rendu UI). */
  onChange?: () => void;
  /** Rotations groupées sur cette fenêtre (arrivée d'une classe entière). */
  rotationDebounceMs?: number;
  /** Délai avant d'utiliser localement une nouvelle clé (le temps qu'elle arrive chez les autres). */
  switchDelayMs?: number;
  now?: () => number;
}

interface Peer extends PeerInfo {
  sessionPub: string;
  /** Moi → lui (j'emballe MA clé média pour lui). */
  wrapOut: CryptoKey;
  /** Lui → moi (j'ouvre SA clé média). */
  wrapIn: CryptoKey;
  /** Dernier seq accepté de ce pair (anti-rejeu), -1 = aucun. */
  lastSeq: number;
  hasKey: boolean;
}

/** Messages reçus avant `start()` ou d'un pair encore en vérification : bornés. */
const MAX_BUFFERED = 32;

export class E2EEKeyExchange {
  private readonly opts: Required<Omit<KeyExchangeOptions, 'onChange'>> &
    Pick<KeyExchangeOptions, 'onChange'>;
  private localIdentity: string | null = null;
  private session: SessionKeys | null = null;
  private disposed = false;

  private readonly peers = new Map<string, Peer>();
  /** Vérification d'annonce en cours, par identité. */
  private readonly verifying = new Map<string, Promise<Peer | null>>();
  /** Pairs refusés, avec la raison (alerte spécifique si la clé a changé). */
  private readonly rejected = new Map<string, 'invalid' | 'keyChanged'>();
  /** Pairs à qui on a déjà envoyé NOTRE annonce pour la session courante. */
  private readonly announcedTo = new Set<string>();
  private readonly earlyQueue: { payload: Uint8Array; sender: string }[] = [];

  private seq = 0;
  private rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly switchTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: KeyExchangeOptions) {
    this.opts = {
      rotationDebounceMs: 300,
      switchDelayMs: 1000,
      now: () => Date.now(),
      trust: async () => 'new',
      ...options,
    };
  }

  /**
   * À appeler dès que l'identité locale est connue (après room.connect) et AVANT de publier le
   * micro : pose notre première clé, diffuse notre annonce et traite les messages déjà reçus.
   */
  async start(localIdentity: string): Promise<void> {
    this.localIdentity = localIdentity;
    this.session = await generateSessionKeys();
    // Clé initiale (seq 0) : jamais vue par personne, utilisable tout de suite.
    await this.opts.setMediaKey(localIdentity, randomMediaKey(), keyIndexOf(0));
    this.opts.send(await this.makeAnnounce());

    const queued = this.earlyQueue.splice(0);
    queued.forEach(({ payload, sender }) => this.handleMessage(payload, sender));
  }

  /** Un participant vient d'arriver : on lui renvoie notre annonce (il a pu manquer la diffusion). */
  peerJoined(identity: string): void {
    if (!this.session || this.disposed) return;
    void this.announceTo(identity);
  }

  /** Un participant est parti : on l'oublie et on change de clé sans lui. */
  peerLeft(identity: string): void {
    this.announcedTo.delete(identity);
    this.verifying.delete(identity);
    this.rejected.delete(identity);
    if (this.peers.delete(identity)) {
      this.scheduleRotation();
      this.opts.onChange?.();
    }
  }

  status(identity: string): PeerKeyStatus {
    const reason = this.rejected.get(identity);
    if (reason) return reason === 'keyChanged' ? 'keyChanged' : 'rejected';
    return this.peers.get(identity)?.hasKey ? 'ready' : 'pending';
  }

  /** Infos d'un pair ACCEPTÉ (undefined sinon). */
  peerInfo(identity: string): PeerInfo | undefined {
    const p = this.peers.get(identity);
    return p && { deviceId: p.deviceId, userId: p.userId, signPub: p.signPub, trust: p.trust };
  }

  /** Reflète localement un « marquer comme vérifié » (déjà persisté par trustStore). */
  markVerified(identity: string): void {
    const p = this.peers.get(identity);
    if (p && p.trust !== 'verified') {
      p.trust = 'verified';
      this.opts.onChange?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    this.switchTimers.forEach(clearTimeout);
    this.switchTimers.clear();
  }

  /** Message reçu sur le topic E2EE. `sender` = identité attestée par le SFU. */
  handleMessage(payload: Uint8Array, sender: string): void {
    if (this.disposed) return;
    if (!this.session) {
      if (this.earlyQueue.length < MAX_BUFFERED) this.earlyQueue.push({ payload, sender });
      return;
    }
    const msg = decodeMessage(payload);
    if (!msg) return;
    if (msg.t === 'announce') void this.onAnnounce(msg, sender);
    else void this.onKey(msg, sender);
  }

  // ── Annonces ──

  private async makeAnnounce(): Promise<AnnounceMsg> {
    return signAnnounce(this.opts.device.keys.sign.privateKey, {
      room: this.opts.room,
      identity: this.localIdentity!,
      deviceId: this.opts.device.deviceId,
      sessionPub: this.session!.pub,
      ts: this.opts.now(),
    });
  }

  private async announceTo(identity: string): Promise<void> {
    if (this.announcedTo.has(identity)) return;
    this.announcedTo.add(identity);
    this.opts.send(await this.makeAnnounce(), [identity]);
  }

  private async onAnnounce(msg: AnnounceMsg, sender: string): Promise<void> {
    const known = this.peers.get(sender);
    if (known && known.sessionPub === msg.sessionPub) return; // doublon (diffusion + direct)
    // Nouvelle session d'un pair connu (reconnexion complète) : elle n'a pas vu notre annonce.
    if (known) this.announcedTo.delete(sender);

    const outcome = this.verifyPeer(msg, sender);
    const verification = outcome.then((r) => (typeof r === 'string' ? null : r));
    this.verifying.set(sender, verification);
    const result = await outcome;
    if (this.disposed || this.verifying.get(sender) !== verification) return;
    this.verifying.delete(sender);

    if (typeof result === 'string') {
      this.rejected.set(sender, result);
      this.peers.delete(sender);
      this.opts.onChange?.();
      return;
    }
    const peer = result;
    this.rejected.delete(sender);
    this.peers.set(sender, peer);
    // Il ne nous connaît peut-être pas encore (arrivé après notre diffusion) : on se présente.
    await this.announceTo(sender);
    this.scheduleRotation();
    this.opts.onChange?.();
  }

  /**
   * Vérifie une annonce de bout en bout. Renvoie le pair accepté, ou la raison du refus (jamais
   * d'exception vers l'appelant).
   */
  private async verifyPeer(
    msg: AnnounceMsg,
    sender: string
  ): Promise<Peer | 'invalid' | 'keyChanged'> {
    try {
      const id = parseIdentity(sender);
      if (
        !id ||
        msg.identity !== sender ||
        msg.deviceId !== id.deviceId ||
        msg.room !== this.opts.room ||
        sender === this.localIdentity ||
        Math.abs(this.opts.now() - msg.ts) > ANNOUNCE_MAX_SKEW_MS
      ) {
        return 'invalid';
      }
      const record = await this.opts.lookup(id.deviceId);
      if (record.userId !== id.userId || record.deviceId !== id.deviceId || record.revokedAt) {
        return 'invalid';
      }
      if (!(await verifyPublicKeys(record)) || !(await verifyAnnounce(msg, record.signPub))) {
        return 'invalid';
      }
      // TOFU : un appareil déjà rencontré avec une AUTRE clé n'est jamais légitime (le serveur
      // interdit de changer les clés d'un appareil) → l'annuaire ment, on refuse.
      const trust = await this.opts.trust({
        deviceId: id.deviceId,
        userId: id.userId,
        signPub: record.signPub,
      });
      if (trust === 'changed') return 'keyChanged';
      const me = this.localIdentity!;
      const priv = this.session!.pair.privateKey;
      const [wrapOut, wrapIn] = await Promise.all([
        deriveWrapKey(priv, msg.sessionPub, this.opts.room, me, sender),
        deriveWrapKey(priv, msg.sessionPub, this.opts.room, sender, me),
      ]);
      return {
        deviceId: id.deviceId,
        userId: id.userId,
        signPub: record.signPub,
        trust,
        sessionPub: msg.sessionPub,
        wrapOut,
        wrapIn,
        lastSeq: -1,
        hasKey: false,
      };
    } catch {
      return 'invalid';
    }
  }

  // ── Clés média ──

  private async onKey(msg: KeyMsg, sender: string): Promise<void> {
    if (msg.from !== sender || msg.to !== this.localIdentity || msg.room !== this.opts.room) return;

    let peer = this.peers.get(sender);
    const pending = this.verifying.get(sender);
    if (pending) peer = (await pending) ?? undefined;
    if (!peer || this.disposed) return;
    if (msg.seq <= peer.lastSeq) return; // rejeu ou message dépassé

    let raw: ArrayBuffer;
    try {
      raw = await unwrapMediaKey(peer.wrapIn, msg);
    } catch {
      return; // enveloppe altérée ou pas pour nous
    }
    // Re-contrôle après l'await : le pair a pu partir ou se reconnecter entre-temps.
    if (this.peers.get(sender) !== peer || msg.seq <= peer.lastSeq) return;
    peer.lastSeq = msg.seq;
    await this.opts.setMediaKey(sender, raw, keyIndexOf(msg.seq));
    if (!peer.hasKey) {
      peer.hasKey = true;
      this.opts.onChange?.();
    }
  }

  private scheduleRotation(): void {
    if (this.disposed) return;
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = null;
      void this.rotate();
    }, this.opts.rotationDebounceMs);
  }

  /** Nouvelle clé média, envoyée à chaque pair vérifié présent, activée après switchDelayMs. */
  private async rotate(): Promise<void> {
    if (this.disposed || !this.localIdentity) return;
    const seq = ++this.seq;
    const raw = randomMediaKey();
    const me = this.localIdentity;

    await Promise.all(
      Array.from(this.peers.entries()).map(async ([identity, peer]) => {
        const msg = await wrapMediaKey(peer.wrapOut, raw, {
          room: this.opts.room,
          from: me,
          to: identity,
          seq,
        });
        if (!this.disposed) this.opts.send(msg, [identity]);
      })
    );

    const timer = setTimeout(() => {
      this.switchTimers.delete(timer);
      // Une rotation plus récente a pu partir entre-temps : seule la dernière s'active.
      if (!this.disposed && this.seq === seq) void this.opts.setMediaKey(me, raw, keyIndexOf(seq));
    }, this.opts.switchDelayMs);
    this.switchTimers.add(timer);
  }
}
