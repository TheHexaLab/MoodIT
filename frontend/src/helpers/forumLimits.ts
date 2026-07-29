/**
 * Limites de saisie des forums, ALIGNÉES sur la validation backend (source de vérité :
 * core-service ForumService.MAX_CONTENT_LENGTH). Le front borne la saisie (maxLength +
 * compteur) pour l'UX ; le backend reste l'autorité (400 si dépassement).
 */

/** Longueur max du CONTENU d'un message (canal) ou d'un post (forum). */
export const MAX_POST_CONTENT_LENGTH = 5000;
