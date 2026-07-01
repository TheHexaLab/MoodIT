// Couture d'autorisation des rooms WebSocket : décide si un utilisateur (identifié
// par l'email de son JWT) a le droit de rejoindre une room donnée (scope:id).
// Le handler ne connaît que cette interface ; l'implémentation active dépend du profil
// (permissive en dev, vérification BD en prod).

package com.moodit.core_service.realtime;

public interface RoomAuthorizer {

  /**
   * @param email email de l'utilisateur (subject du JWT, posé au handshake)
   * @param scope "channel" | "forum" | "program" | "user"
   * @param id identifiant de la room dans ce scope
   * @return true si l'utilisateur peut rejoindre cette room
   */
  boolean canJoin(String email, String scope, long id);
}
