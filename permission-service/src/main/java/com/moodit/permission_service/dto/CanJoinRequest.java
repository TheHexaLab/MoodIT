// Corps de la requete pour autoriser l'abonnement a une room WebSocket.
// Envoye (a terme) par le RoomAuthorizer du core ; scope = channel|forum|program|user.

package com.moodit.permission_service.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

@Data
public class CanJoinRequest {

  @NotBlank private String email;

  @NotBlank private String scope;

  @NotNull private Long id;
}
