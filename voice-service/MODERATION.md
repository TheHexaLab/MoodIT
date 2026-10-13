# Modération vocale : contrat backend (pour l'UI)

Un **modérateur** d'un salon vocal peut couper le micro d'un participant (server-mute) ou l'expulser.

**Qui est modérateur ?** Un Administrateur ou un Gardien **global**, ou un Administrateur ou un **Enseignant** d'un
programme du cours du canal. Ce sont les mêmes personnes que celles qui gèrent le contenu du cours. Contrairement à la
suppression de messages, l'Enseignant **est** modérateur ici. La règle est dans `MembershipService.canModerateVoice`
(permission-service) et elle est vérifiée deux fois : au gateway, puis par voice-service.

Toutes les actions visent une **personne** (`userId` = `User_.id`) et s'appliquent à **tous ses appareils** connectés.

## 1. Savoir quoi afficher : `POST /api/voice/token`

La réponse a trois nouveaux champs :

```jsonc
{
  "token": "…", "url": "ws://…", "room": "channel:11",
  "userId": 7,          // mon User_.id (= préfixe de mon identité LiveKit)
  "canModerate": true,  // afficher les actions de modération sur les AUTRES participants
  "serverMuted": false  // je rejoins en étant coupé par un modérateur
}
```

L'`userId` d'un participant se lit dans son identité LiveKit, `"<userId>.<deviceId>"` :
`Number(participant.identity.split('.')[0])`.

## 2. Actions (modérateur seulement)

| Action | Requête | Réponse |
|---|---|---|
| Couper le micro | `POST /api/voice/channels/{channelId}/participants/{userId}/mute` | `204` |
| Lever le mute | `DELETE /api/voice/channels/{channelId}/participants/{userId}/mute` | `204` |
| Expulser | `POST /api/voice/channels/{channelId}/participants/{userId}/kick` | `200 {"removedDevices": n}` |

Pas de corps de requête. `channelId` est l'id du forum 'Voice', le même que pour `/api/voice/token`.

Codes d'erreur :
- `403` : l'appelant n'est pas modérateur.
- `404` : la personne n'est pas dans le salon (pour le mute et l'expulsion).

Ces actions sont idempotentes. Le modérateur n'a pas besoin d'être lui-même dans le salon.

## 3. Comportement côté participants (ce que l'UI doit refléter)

**Server-mute**
- La piste micro est coupée immédiatement : `TrackMuted` chez tout le monde, et le badge « muet » existant s'affiche.
- Le participant **perd le droit** de publier son micro. `setMicrophoneEnabled(true)` échoue, et il reçoit
  `RoomEvent.ParticipantPermissionsChanged` (`canPublishSources` n'inclut plus `MICROPHONE`). L'UI devrait désactiver
  son bouton micro et afficher « Micro coupé par un modérateur ».
- La caméra, le partage d'écran et le data channel restent permis. Le chiffrement de bout en bout n'est pas affecté.
- Le mute **survit à une reconnexion**, car le jeton est émis sans le micro (`serverMuted: true`).

**Lever le mute**
- Le participant **peut** rallumer son micro, mais on ne le rallume pas à sa place.

**Liste des personnes coupées**
- Elle est lisible par tous dans les métadonnées du salon : `room.metadata` vaut `{"serverMuted":[7,12]}`.
- Pour un badge en direct, écouter `RoomEvent.RoomMetadataChanged`.
- Seul le serveur peut modifier cette liste. Elle disparaît quand le salon se vide et expire.

**Expulsion**
- Tous les appareils de la personne sont déconnectés : `RoomEvent.Disconnected` avec la raison
  `DisconnectReason.PARTICIPANT_REMOVED`. L'UI peut afficher « Vous avez été retiré du salon ».
- Ce n'est **pas** un bannissement : la personne peut revenir. Si elle était coupée, le mute persiste.

**Suppression du canal**
- Quand le canal vocal est supprimé (éditeur de section, forum ou cours), le salon LiveKit est **fermé** côté serveur.
  Tout le monde est déconnecté, avec la raison `ROOM_DELETED`.

## Vérification

Les tests e2e sont dans `frontend/e2e/voice/voice-moderation.spec.ts`. Ils couvrent :
- le mute réellement silencieux, mesuré à l'audio ;
- le refus de réactivation ;
- la persistance après reconnexion ;
- la levée du mute ;
- l'expulsion multi-appareils ;
- les refus `403` et `404` ;
- la fermeture du salon à la suppression du canal.

Ces tests ont été validés par mutation : sans la restriction de permission, ou sans le jeton restreint, ils échouent.
