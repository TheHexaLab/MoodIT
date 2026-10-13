import { BaseKeyProvider, createKeyMaterialFromBuffer } from 'livekit-client';

/**
 * Fournisseur de clés E2EE « une clé par émetteur » (sender keys, cf. voice-service/E2EE.md §5.6).
 *
 * Contrairement à `ExternalE2EEKeyProvider` (une passphrase partagée par tout le salon), chaque
 * participant a SA clé média, qu'on enregistre ici sous son identité LiveKit. Le worker de
 * chiffrement du SDK choisit la clé selon l'émetteur de la trame et son index.
 */
export class MooditKeyProvider extends BaseKeyProvider {
  constructor() {
    super({
      sharedKey: false,
      // Pas d'auto-ratchet sur échec de déchiffrement : nos clés sont tirées au hasard à chaque
      // rotation, pas dérivées par ratchet → un ratchet silencieux désynchroniserait les pairs.
      ratchetWindowSize: 0,
      // Garde les anciens index pendant une rotation (les trames portent leur index).
      keyringSize: 16,
      // Clients web uniquement : AES-256 (le 128 par défaut ne sert qu'aux SDK natifs).
      keySize: 256,
    });
  }

  /**
   * Enregistre la clé média d'un participant (local ou distant).
   * @param identity identité LiveKit du participant émetteur
   * @param rawKey 32 octets aléatoires (matériau HKDF, dérivé ensuite par le worker)
   * @param keyIndex index de rotation (0..keyringSize-1, cyclique)
   */
  async setParticipantKey(identity: string, rawKey: ArrayBuffer, keyIndex = 0): Promise<void> {
    const material = await createKeyMaterialFromBuffer(rawKey);
    this.onSetEncryptionKey(material, identity, keyIndex);
  }
}
