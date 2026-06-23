// Établissement autorisé : seuls les emails dont le domaine est listé ici
// peuvent s'inscrire. Table alimentée hors de l'auth-service (lecture seule ici).

package com.moodit.auth_service.model;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "establishment")
public class Establishment {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Integer id;

  @Column(nullable = false, length = 128)
  private String name;

  @Column(name = "domain_email", nullable = false, unique = true, length = 256)
  private String domainEmail;
}
