// Oui/non d'acces a une "room" (ici : salon vocal, scope "channel"). Dupplique depuis core
// (petit, sans etat) : la decision est deleguee au permission-service, ce service n'embarque
// AUCUNE logique d'autorisation par role.

package com.moodit.voice_service.authz;

public interface RoomAuthorizer {

  /**
   * @param email email de l'utilisateur (X-User-Email pose par le gateway)
   * @param scope "channel" | "forum" | "program" | "user"
   * @param id identifiant de la room dans ce scope
   * @return true si l'utilisateur peut rejoindre cette room
   */
  boolean canJoin(String email, String scope, long id);
}
