// Réponse de l'endpoint INTERNE de vérification d'appartenance (appelé par voice-service avant de
// signer un JoinToken) : de quoi construire l'identité LiveKit "<userId>.<deviceId>" et son nom.

package com.moodit.core_service.voice.e2ee.dto;

public record DeviceOwnerDTO(int userId, String username) {}
