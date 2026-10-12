// Un participant présent dans un salon vocal, tel que diffusé dans l'évènement
// `voice:presence` (sidebar). On expose l'id + un nom d'affichage — PAS l'email
// (contrairement à l'identité LiveKit brute, cf. TODO confidentialité du VoiceTokenController).

package com.moodit.core_service.realtime.dto;

public record VoicePresenceParticipant(int id, String name) {}
