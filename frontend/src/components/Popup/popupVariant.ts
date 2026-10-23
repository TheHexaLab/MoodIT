/**
 * Variantes de la popup centralisée (`Popup`). La variante choisit le CONTENEUR : largeur,
 * hauteur maximale, défilement et rang d'empilement. Le contenu (en-tête, champs, boutons) reste
 * à la charge de chaque popup.
 *
 * Énumération sous forme d'objet constant : le projet compile avec `erasableSyntaxOnly`, qui
 * interdit le mot-clé `enum`. L'usage est le même (`PopupVariant.Form`) et le type `PopupVariant`
 * n'accepte que ces valeurs.
 *
 * Empilement (z-index) : les formulaires et éditeurs partagent le rang 90 (au-dessus du tiroir
 * mobile, 80) ; une confirmation (1100) passe au-dessus de l'éditeur de quiz (1000) ; une erreur
 * (1200) passe au-dessus de tout.
 */
export const PopupVariant = {
  /** Message d'erreur : étroit (23 rem), au-dessus de tout, rôle `alertdialog`. */
  Alert: 'alert',
  /** Confirmation (supprimer, quitter…) : étroit (25,75 rem), au-dessus des éditeurs. */
  Confirm: 'confirm',
  /** Formulaire court (profil, cours, rôles…) : 25,75 rem, défile si l'écran est bas. */
  Form: 'form',
  /** Formulaire à étapes ou à liste (programme, abonnement, rejoindre des cours) : 28,75 rem. */
  FormWide: 'form-wide',
  /** Éditeur de contenu (sections, quiz) : 30 rem, bordure, largeur ajustable. */
  Editor: 'editor',
  /** Consultation d'une liste filtrable (journal d'audit) : 34 rem, hauteur bornée. */
  Browser: 'browser',
  /** Espace de travail à vues (gestion MCP) : 47,5 rem, le corps gère son défilement. */
  Workspace: 'workspace',
} as const;

export type PopupVariant = (typeof PopupVariant)[keyof typeof PopupVariant];
