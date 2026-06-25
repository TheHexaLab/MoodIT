// Corps de la requete envoyee par le gateway pour autoriser un acces.

package com.moodit.permission_service.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class ValidateRequest {

  // Identite resolue par le gateway a partir du JWT (deja valide cote auth-service).
  @NotBlank private String email;

  // Route demandee, ex: "/api/quiz/12".
  @NotBlank private String path;

  // Methode HTTP, ex: "POST".
  @NotBlank private String method;

  // Corps brut (JSON) de la requete, transmis par le gateway pour les routes dont
  // l'id de ressource est dans le body (ex: forumId). Null/absent pour GET/DELETE.
  private String body;
}
