import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Accès ADMIN au LiveKit de DEV depuis les tests (API serveur Twirp, comme voice-service pour
 * l'éjection). Sert à VIDER le salon de test avant chaque test : un test qui échoue ou dépasse son
 * délai laisse sinon des participants « fantômes » (~20 s) qui feraient échouer les suivants.
 * Clés lues dans le .env racine (LIVEKIT_API_KEY / LIVEKIT_API_SECRET) — dev uniquement.
 */

function readDotEnv(): Record<string, string> {
  const path = resolve(process.cwd(), '..', '.env');
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])
  );
}

const env = { ...readDotEnv(), ...process.env };
const API_URL = env.LIVEKIT_API_URL ?? 'http://localhost:7880';
const API_KEY = env.LIVEKIT_API_KEY ?? 'devkey';
const API_SECRET = env.LIVEKIT_API_SECRET ?? 'dev-livekit-secret-change-me-32bytes-min';

/** Salon LiveKit du canal vocal de test ("channel:<forumId>", forum 11 du seed d'init.sql). */
export const TEST_ROOM = env.E2E_VOICE_ROOM ?? 'channel:11';

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

function adminToken(room: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: API_KEY,
      sub: 'moodit-e2e',
      nbf: now,
      exp: now + 60,
      video: { roomAdmin: true, roomList: true, roomCreate: true, room }, // roomCreate : DeleteRoom
    })
  );
  const sig = createHmac('sha256', API_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function twirp<T>(method: string, room: string, body: object): Promise<T> {
  const res = await fetch(`${API_URL}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken(room)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`[e2e] LiveKit ${method} : HTTP ${res.status} ${await res.text()}`);
  }
  return (res.status === 404 ? {} : await res.json()) as T;
}

/**
 * Ferme le salon de test (DeleteRoom : participants déconnectés ET métadonnées effacées, dont les
 * server-mutes de la modération) puis attend qu'il soit vide.
 */
export async function emptyTestRoom(room = TEST_ROOM): Promise<void> {
  await twirp('DeleteRoom', room, { room });
  for (let attempt = 0; attempt < 20; attempt++) {
    const { participants = [] } = await twirp<{ participants?: { identity: string }[] }>(
      'ListParticipants',
      room,
      { room }
    );
    if (participants.length === 0) return;
    await Promise.all(
      participants.map((p) => twirp('RemoveParticipant', room, { room, identity: p.identity }))
    );
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`[e2e] le salon ${room} ne se vide pas`);
}

/** Le salon est-il actif côté LiveKit ? (un salon vidé par ses participants survit ~5 min). */
export async function roomExists(room: string): Promise<boolean> {
  const { rooms = [] } = await twirp<{ rooms?: { name: string }[] }>('ListRooms', room, {
    names: [room],
  });
  return rooms.some((r) => r.name === room);
}
