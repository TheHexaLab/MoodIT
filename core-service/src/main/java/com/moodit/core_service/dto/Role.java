// Rôle global de l'utilisateur (table Role, liée via User_Role). Calqué sur le type
// `Role` du domaine frontend (id + name). Les rôles PAR PROGRAMME (User_Program_Role)
// ne sont pas exposés ici (gestion enseignant par programme : non implémentée).
//
// NB : DTO de projection (record) distinct de l'entité `model.Role` — d'où le package dto.

package com.moodit.core_service.dto;

public record Role(long id, String name) {}
