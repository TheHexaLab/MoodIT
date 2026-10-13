// Contrôle de COHÉRENCE des clés publiques envoyées par un navigateur à l'enregistrement.
//
// Le serveur n'est PAS l'ancre de confiance du chiffrement (les clients vérifient eux-mêmes,
// E2EE.md §5.3) : ce contrôle évite seulement de stocker des clés inutilisables ou d'un autre
// type, qui casseraient l'échange de clés chez les autres participants.
//
// Formats imposés par WebCrypto côté navigateur :
//   - clés publiques exportées en SPKI ('spki'), encodées en Base64 ;
//   - signature ECDSA au format IEEE P1363 (r || s, 64 octets pour P-256), d'où l'algo Java
//     "SHA256withECDSAinP1363Format" (et NON "SHA256withECDSA", qui attend du DER).

package com.moodit.core_service.voice.e2ee;

import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

final class DeviceKeyVerifier {

  /** Taille max d'une valeur Base64 acceptée (une SPKI P-256 fait ~124 caractères). */
  static final int MAX_B64_LENGTH = 512;

  private DeviceKeyVerifier() {}

  /**
   * @return true si signPub et dhPub sont des clés EC P-256 valides et que dhSig est une
   *     signature valide de dhPub (octets SPKI décodés) par signPub.
   */
  static boolean isValid(String signPubB64, String dhPubB64, String dhSigB64) {
    try {
      PublicKey signPub = parseP256(signPubB64);
      byte[] dhSpki = decode(dhPubB64);
      parseP256(dhPubB64);

      Signature verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
      verifier.initVerify(signPub);
      verifier.update(dhSpki);
      return verifier.verify(decode(dhSigB64));
    } catch (GeneralSecurityException | IllegalArgumentException e) {
      return false;
    }
  }

  private static PublicKey parseP256(String b64) throws GeneralSecurityException {
    PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(decode(b64)));
    // P-256 uniquement (champ premier de 256 bits) : refuse P-384/P-521 et toute autre courbe.
    if (!(key instanceof ECPublicKey ec) || ec.getParams().getCurve().getField().getFieldSize() != 256) {
      throw new GeneralSecurityException("courbe non supportée (P-256 attendu)");
    }
    return key;
  }

  private static byte[] decode(String b64) {
    if (b64 == null || b64.isBlank() || b64.length() > MAX_B64_LENGTH) {
      throw new IllegalArgumentException("valeur Base64 absente ou trop longue");
    }
    return Base64.getDecoder().decode(b64);
  }
}
