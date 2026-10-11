// Reponse de POST /voice/token : tout ce qu'il faut au navigateur pour se connecter au SFU.
//   token : le JoinToken signe (JWT LiveKit)
//   url   : URL publique du SFU LiveKit (WebSocket de signalisation)
//   room  : nom du salon LiveKit rejoint ("channel:<id>")

package com.moodit.core_service.voice.dto;

public record VoiceTokenResponse(String token, String url, String room) {}
