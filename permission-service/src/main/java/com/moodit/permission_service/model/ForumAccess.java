package com.moodit.permission_service.model;

/**
 * Accès d'un utilisateur à un forum, avec ce que son type implique pour l'écriture. Un nouveau
 * type de forum aux règles propres = une constante ici, traitée par le `switch` de
 * PermissionService.canWriteInForum (le compilateur signale le cas manquant).
 */
public enum ForumAccess {
  /** Forum invisible (pas abonné à un programme de son cours) ou inexistant. */
  NONE,
  /** Forum visible, ouvert à l'écriture des membres (canal 'Discussion', forum 'Thread'). */
  READ,
  /** Canal d'annonces visible : seul le personnel du cours y écrit. */
  ANNOUNCEMENT;

  /** Accès d'après le type du forum visible (F_Type.name), ou null s'il n'est pas visible. */
  public static ForumAccess ofVisibleType(String typeName) {
    if (typeName == null) {
      return NONE;
    }
    return "Announcement".equals(typeName) ? ANNOUNCEMENT : READ;
  }
}
