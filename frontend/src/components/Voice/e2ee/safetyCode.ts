import { fromBase64 } from './deviceCrypto';

/**
 * Code de sécurité entre deux appareils (style Signal, voice-service/E2EE.md §5.3) : 60 chiffres
 * en 12 groupes de 5, dérivés des DEUX clés d'identité. Identique des deux côtés (clés triées).
 * Deux personnes qui lisent le même code (de vive voix, en personne) savent qu'aucun serveur ne
 * s'est interposé entre leurs appareils ; elles peuvent alors marquer l'appareil « vérifié ».
 */
export async function safetyCode(signPubA: string, signPubB: string): Promise<string> {
  const [first, second] = [signPubA, signPubB].sort();
  const a = new Uint8Array(fromBase64(first));
  const b = new Uint8Array(fromBase64(second));
  const prefix = new TextEncoder().encode('moodit-safety-code/v1');
  const input = new Uint8Array(prefix.length + a.length + b.length);
  input.set(prefix, 0);
  input.set(a, prefix.length);
  input.set(b, prefix.length + a.length);

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', input));
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    // 5 octets (40 bits) → nombre < 2^40, réduit à 5 chiffres (biais négligeable : 2^40 ≫ 10^5).
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + hash[i * 5 + j];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}
