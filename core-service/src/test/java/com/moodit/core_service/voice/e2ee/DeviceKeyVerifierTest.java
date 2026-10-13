package com.moodit.core_service.voice.e2ee;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Vecteurs produits par WebCrypto (Node, même API que le navigateur) : clés exportées en SPKI,
 * signature ECDSA P-256/SHA-256 au format P1363. Garantit que Java vérifie EXACTEMENT ce que le
 * front produit (piège classique : DER vs P1363).
 */
class DeviceKeyVerifierTest {

  private static final String SIGN_PUB =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgEPwC5GCI6cTrUIeFNUsnhAo4qCyX21S3JC8bXV+WvwKaN0VcEknA4Nz958Hd6Roizq8ePGn5FcmeF6OLXlR2g==";
  private static final String DH_PUB =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE3PidRDhQT7BctXVbkGKmU7QkR1iNr8AVVX4n/aalGD+cvUHb7qefEivrXdHm9+TK8p6589WpawO6vStcCFX5rA==";
  private static final String DH_SIG =
      "t3YO48zDpbtdSOKjIAEt2yjogOdEiHQ49KGFaWBhjJJN1H5xmYruzx+qxZafjZaK7irrsFdVEaBiiw0E0KWFRg==";
  private static final String P384_PUB =
      "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEIkdHyIyzVTFQejbVoFADR7SdBiiz5rHwdzVYMtcFkN1oa/3ElfgUTqqRKL5MnIC4qrX9M1s9f3Q6w0fnTFEvzW8+9p/DmBhzj/STwYi4WYBiKZqOZQDVWsMTnkDsEcIN";

  @Test
  void acceptsWebCryptoSignature() {
    assertThat(DeviceKeyVerifier.isValid(SIGN_PUB, DH_PUB, DH_SIG)).isTrue();
  }

  @Test
  void rejectsSignatureOverAnotherKey() {
    // dh_pub et sign_pub échangés : la signature ne couvre plus la clé présentée.
    assertThat(DeviceKeyVerifier.isValid(DH_PUB, SIGN_PUB, DH_SIG)).isFalse();
  }

  @Test
  void rejectsTamperedSignature() {
    String tampered = (DH_SIG.charAt(0) == 'A' ? "B" : "A") + DH_SIG.substring(1);
    assertThat(DeviceKeyVerifier.isValid(SIGN_PUB, DH_PUB, tampered)).isFalse();
  }

  @Test
  void rejectsNonP256Curve() {
    assertThat(DeviceKeyVerifier.isValid(SIGN_PUB, P384_PUB, DH_SIG)).isFalse();
  }

  @Test
  void rejectsGarbageAndOversizedInput() {
    assertThat(DeviceKeyVerifier.isValid("pas-du-base64!", DH_PUB, DH_SIG)).isFalse();
    assertThat(DeviceKeyVerifier.isValid(SIGN_PUB, DH_PUB, "A".repeat(600))).isFalse();
    assertThat(DeviceKeyVerifier.isValid(null, DH_PUB, DH_SIG)).isFalse();
  }
}
