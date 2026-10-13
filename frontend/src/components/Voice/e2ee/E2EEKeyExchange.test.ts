import { describe, expect, it, vi } from 'vitest';
import { exportPublicKeys, generateDeviceKeys } from './deviceCrypto';
import { E2EEKeyExchange } from './E2EEKeyExchange';
import { type DeviceKeyRecord } from './keyDirectory';
import { decodeMessage, encodeMessage, type E2EEMessage, type KeyMsg } from './protocol';
import { evaluateTrust, type TrustRecord } from './trustStore';

/**
 * Réseau simulé : chaque nœud = un navigateur avec son E2EEKeyExchange, de VRAIES clés WebCrypto,
 * un annuaire partagé (le « serveur ») et un trousseau qui enregistre les clés posées. Livraison
 * asynchrone et ordonnée par émetteur, comme le data channel fiable de LiveKit.
 */

const ROOM = 'channel:11';
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

interface Node {
  id: string;
  kx: E2EEKeyExchange;
  /** Dernière clé posée par identité (locale ou distante), en hex, + son index. */
  last: Map<string, { key: string; index: number }>;
  /** Mémoire TOFU de ce navigateur. */
  memory: Map<string, TrustRecord>;
}

function makeNetwork() {
  const directory = new Map<string, DeviceKeyRecord>();
  const nodes = new Map<string, Node>();
  const log: { from: string; to?: string[]; msg: E2EEMessage }[] = [];

  const deliver = (from: string, msg: E2EEMessage, to?: string[]) => {
    log.push({ from, to, msg });
    const targets = to ?? Array.from(nodes.keys()).filter((id) => id !== from);
    const payload = encodeMessage(msg);
    targets.forEach((t) => setTimeout(() => nodes.get(t)?.kx.handleMessage(payload, from), 0));
  };

  /**
   * Mémoire TOFU par nœud (même logique que trustStore, en mémoire). Partageable entre deux
   * nœuds pour simuler le MÊME navigateur qui revient dans une nouvelle session.
   */
  type TrustMemory = Map<string, TrustRecord>;

  async function createNode(
    userId: number,
    tamper?: (rec: DeviceKeyRecord) => Promise<DeviceKeyRecord> | DeviceKeyRecord,
    memory: TrustMemory = new Map()
  ): Promise<Node> {
    const keys = await generateDeviceKeys();
    const deviceId = crypto.randomUUID();
    let record: DeviceKeyRecord = {
      deviceId,
      userId,
      username: `user${userId}`,
      label: null,
      createdAt: '2026-10-12T00:00:00',
      revokedAt: null,
      ...(await exportPublicKeys(keys)),
    };
    const pub = await exportPublicKeys(keys);
    if (tamper) record = await tamper(record);
    directory.set(deviceId, record);

    const id = `${userId}.${deviceId}`;
    const last: Node['last'] = new Map();
    const kx = new E2EEKeyExchange({
      room: ROOM,
      device: { userId, deviceId, keys, pub },
      trust: async (peer) => {
        const level = evaluateTrust(memory.get(peer.deviceId), peer);
        if (level === 'new') {
          memory.set(peer.deviceId, {
            key: peer.deviceId,
            ...peer,
            verified: false,
            firstSeen: '',
          });
        }
        return level;
      },
      send: (msg, to) => deliver(id, msg, to),
      lookup: async (d) => {
        const r = directory.get(d);
        if (!r) throw new Error('404');
        return r;
      },
      setMediaKey: async (identity, raw, index) => {
        last.set(identity, { key: hex(raw), index });
      },
      rotationDebounceMs: 10,
      switchDelayMs: 20,
    });
    return { id, kx, last, memory };
  }

  async function join(node: Node) {
    nodes.forEach((o) => o.kx.peerJoined(node.id));
    nodes.set(node.id, node);
    await node.kx.start(node.id);
  }

  function leave(node: Node) {
    nodes.delete(node.id);
    node.kx.dispose();
    nodes.forEach((o) => o.kx.peerLeft(node.id));
  }

  /** Chaque nœud détient la clé COURANTE (même valeur, même index) de chaque autre nœud. */
  function converged(): boolean {
    const all = Array.from(nodes.values());
    return all.every((a) =>
      all.every((b) => {
        if (a === b) return true;
        const theirs = b.last.get(b.id);
        const mine = a.last.get(b.id);
        return !!theirs && !!mine && theirs.key === mine.key && theirs.index === mine.index;
      })
    );
  }

  return { directory, nodes, log, createNode, join, leave, converged };
}

const waitConverged = (net: ReturnType<typeof makeNetwork>) =>
  vi.waitFor(() => expect(net.converged()).toBe(true), { timeout: 3000, interval: 10 });

describe('E2EEKeyExchange', () => {
  it('deux participants finissent par avoir chacun la clé courante de l’autre', async () => {
    const net = makeNetwork();
    const a = await net.createNode(1);
    const b = await net.createNode(2);
    await net.join(a);
    await net.join(b);

    await waitConverged(net);
    expect(a.kx.status(b.id)).toBe('ready');
    expect(b.kx.status(a.id)).toBe('ready');
  });

  it('un arrivant déclenche une rotation : il ne reçoit jamais la clé d’avant son arrivée', async () => {
    const net = makeNetwork();
    const a = await net.createNode(1);
    const b = await net.createNode(2);
    await net.join(a);
    await net.join(b);
    await waitConverged(net);
    const aKeyBefore = a.last.get(a.id)!.key;

    const c = await net.createNode(3);
    await net.join(c);
    await waitConverged(net);

    expect(a.last.get(a.id)!.key).not.toBe(aKeyBefore);
    // C n'a jamais vu passer l'ancienne clé de A.
    const keysSentToC = net.log.filter((l) => l.to?.includes(c.id) && l.msg.t === 'key');
    expect(keysSentToC.length).toBeGreaterThan(0);
    expect(c.last.get(a.id)!.key).not.toBe(aKeyBefore);
  });

  it('un partant ne reçoit pas la clé suivante', async () => {
    const net = makeNetwork();
    const [a, b, c] = await Promise.all([1, 2, 3].map((u) => net.createNode(u)));
    for (const n of [a, b, c]) await net.join(n);
    await waitConverged(net);
    const aKeyBefore = a.last.get(a.id)!.key;
    const cKnowsOfA = c.last.get(a.id)!.key;

    net.leave(c);
    await vi.waitFor(() => expect(a.last.get(a.id)!.key).not.toBe(aKeyBefore), { timeout: 3000 });
    await waitConverged(net);

    expect(c.last.get(a.id)!.key).toBe(cKnowsOfA); // figé à l'ancienne clé
    expect(b.last.get(a.id)!.key).toBe(a.last.get(a.id)!.key);
  });

  it('rejette un appareil dont l’annuaire porte d’autres clés (substitution par le serveur)', async () => {
    const net = makeNetwork();
    const a = await net.createNode(1);
    const evil = await net.createNode(2, async (rec) => ({
      ...rec,
      ...(await exportPublicKeys(await generateDeviceKeys())),
    }));
    await net.join(a);
    await net.join(evil);

    await vi.waitFor(() => expect(a.kx.status(evil.id)).toBe('rejected'), { timeout: 3000 });
    // A n'a jamais emballé sa clé pour l'appareil rejeté.
    expect(net.log.some((l) => l.from === a.id && l.msg.t === 'key' && l.to?.includes(evil.id))).toBe(
      false
    );
  });

  it('rejette un appareil révoqué', async () => {
    const net = makeNetwork();
    const a = await net.createNode(1);
    const revoked = await net.createNode(2, (rec) => ({ ...rec, revokedAt: '2026-10-12T10:00:00' }));
    await net.join(a);
    await net.join(revoked);

    await vi.waitFor(() => expect(a.kx.status(revoked.id)).toBe('rejected'), { timeout: 3000 });
  });

  it('rejette une annonce relayée sous une autre identité que celle attestée par le SFU', async () => {
    const net = makeNetwork();
    const a = await net.createNode(1);
    const b = await net.createNode(2);
    await net.join(a);
    await net.join(b);
    await waitConverged(net);

    const bAnnounce = net.log.find((l) => l.from === b.id && l.msg.t === 'announce')!.msg;
    const impostor = `3.${crypto.randomUUID()}`;
    a.kx.handleMessage(encodeMessage(bAnnounce), impostor);

    await vi.waitFor(() => expect(a.kx.status(impostor)).toBe('rejected'), { timeout: 3000 });
    expect(a.kx.status(b.id)).toBe('ready');
  });

  it('ignore le rejeu d’une ancienne enveloppe de clé', async () => {
    const net = makeNetwork();
    const a = await net.createNode(1);
    const b = await net.createNode(2);
    await net.join(a);
    await net.join(b);
    await waitConverged(net);

    const firstKeyToB = net.log.find(
      (l) => l.from === a.id && l.msg.t === 'key' && (l.msg as KeyMsg).to === b.id
    )!.msg;
    // Rotation supplémentaire : A passe à une clé plus récente.
    const c = await net.createNode(3);
    await net.join(c);
    await waitConverged(net);
    const current = b.last.get(a.id)!.key;

    b.kx.handleMessage(encodeMessage(firstKeyToB), a.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.last.get(a.id)!.key).toBe(current);
  });

  it('TOFU : un appareil connu qui revient avec une AUTRE clé est refusé (keyChanged)', async () => {
    const net = makeNetwork();
    const a = await net.createNode(1);
    const b = await net.createNode(2);
    // A a déjà rencontré l'appareil de B… avec une autre clé (l'annuaire a été modifié depuis).
    const bDevice = b.id.split('.')[1];
    const other = await exportPublicKeys(await generateDeviceKeys());
    a.memory.set(bDevice, {
      key: bDevice,
      deviceId: bDevice,
      userId: 2,
      signPub: other.signPub,
      verified: true,
      firstSeen: '',
    });
    await net.join(a);
    await net.join(b);

    await vi.waitFor(() => expect(a.kx.status(b.id)).toBe('keyChanged'), { timeout: 3000 });
    expect(net.log.some((l) => l.from === a.id && l.msg.t === 'key' && l.to?.includes(b.id))).toBe(
      false
    );
    // La mémoire n'est PAS écrasée par la nouvelle clé.
    expect(a.memory.get(bDevice)!.signPub).toBe(other.signPub);
  });

  it('TOFU : « nouveau » à la 1re rencontre, « connu » ensuite, « vérifié » une fois marqué', async () => {
    const net = makeNetwork();
    const a = await net.createNode(1);
    const b = await net.createNode(2);
    await net.join(a);
    await net.join(b);
    await waitConverged(net);
    expect(a.kx.peerInfo(b.id)!.trust).toBe('new');

    a.kx.markVerified(b.id);
    expect(a.kx.peerInfo(b.id)!.trust).toBe('verified');

    // Même navigateur (même mémoire), nouvelle session dans un autre salon simulé.
    const net2 = makeNetwork();
    const a2 = await net2.createNode(1, undefined, a.memory);
    for (const [k, v] of net.directory) net2.directory.set(k, v);
    net.leave(a);
    await net2.join(a2);
    // B (même appareil) rejoint ce nouveau salon : réutilise ses clés d'appareil via l'annuaire.
    a2.kx.handleMessage(
      encodeMessage(net.log.find((l) => l.from === b.id && l.msg.t === 'announce')!.msg),
      b.id
    );
    await vi.waitFor(() => expect(a2.kx.peerInfo(b.id)?.trust).toBe('known'), { timeout: 3000 });
  });

  it('decodeMessage refuse les messages mal formés', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ t: 'key', v: 1, room: ROOM }));
    expect(decodeMessage(bad)).toBeNull();
    expect(decodeMessage(new TextEncoder().encode('pas du json'))).toBeNull();
  });
});
