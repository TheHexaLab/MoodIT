package com.moodit.core_service.internal;

import com.moodit.core_service.voice.e2ee.DeviceKeyService;
import com.moodit.core_service.voice.e2ee.dto.DeviceOwnerDTO;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Endpoint INTERNE (service à service) : l'appareil {@code deviceId} est-il ACTIF et à
 * l'utilisateur {@code email} ? Appelé par voice-service AVANT de signer un JoinToken dont
 * l'identité LiveKit est {@code "<userId>.<deviceId>"} (voice-service/E2EE.md §5.4). Hors préfixe
 * /api (cf. WebMvcConfig) et NON routé par le gateway ; authentifié par {@code X-Internal-Token}.
 */
@RestController
@RequestMapping("/internal/keys/devices")
@RequiredArgsConstructor
@ConditionalOnProperty(prefix = "moodit.voice", name = "enabled", havingValue = "true")
public class InternalDeviceKeyController {

    private final DeviceKeyService deviceKeyService;

    @Value("${app.internal.token:}")
    private String internalToken;

    /** 200 + propriétaire si actif et à `email` ; 404 sinon (révoqué, inconnu ou autre user). */
    @GetMapping("/{deviceId}/owner")
    public ResponseEntity<DeviceOwnerDTO> owner(
            @RequestHeader(value = "X-Internal-Token", required = false) String token,
            @PathVariable UUID deviceId,
            @RequestParam String email) {
        if (unauthorized(token)) return ResponseEntity.status(403).build();
        return deviceKeyService
                .activeOwner(deviceId, email)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Même contrôle que InternalQuizController : temps constant, obligatoire en prod. */
    private boolean unauthorized(String token) {
        if (internalToken == null || internalToken.isBlank()) return false;
        if (token == null) return true;
        return !MessageDigest.isEqual(
                internalToken.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
    }
}
