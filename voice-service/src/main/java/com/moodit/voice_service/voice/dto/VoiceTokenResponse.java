// Reponse de POST /api/voice/token : tout ce qu'il faut au navigateur pour se connecter au SFU.
//   token       : le JoinToken signe (JWT LiveKit)
//   url         : URL publique du SFU LiveKit (WebSocket de signalisation)
//   room        : nom du salon LiveKit rejoint ("channel:<id>")
//   userId      : User_.id de l'appelant (= prefixe de son identite LiveKit "<userId>.<deviceId>")
//   canModerate : l'appelant peut server-mute / expulser dans ce salon (affichage des actions)
//   serverMuted : l'appelant est server-mute par un moderateur (micro interdit a la connexion)

package com.moodit.voice_service.voice.dto;

public record VoiceTokenResponse(
    String token, String url, String room, int userId, boolean canModerate, boolean serverMuted) {}
