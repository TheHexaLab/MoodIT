/** Types de données et de libellés du UpdateCoursePopup. */

/** Valeur synchrone ou asynchrone : le callback de sauvegarde peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/** Reflète la table `Program`. */
export interface Program {
  id: number;
  name: string;
  code: string;
  cohort: string;
  color: string;
}

/** Cours existant à éditer (reflète `Course` + les liens `program_course`). */
export interface CourseData {
  title: string;
  code: string;
  programIds: number[];
}

/** Modification de cours (reflète `Course` + les liens `program_course`). */
export interface CourseUpdate {
  title: string;
  code: string;
  programIds: number[];
}

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface UpdateCoursePopupLabels {
  /** Titre du panneau. */
  title: string;
  /** Description sous le titre. */
  subtitle: string;
  /** Libellé du champ des programmes. */
  programsLabel: string;
  /** Invite affichée dans le champ quand aucun programme n'est sélectionné. */
  programsPlaceholder: string;
  /** Invite du champ de recherche du menu. */
  searchPlaceholder: string;
  /** Message du menu quand aucun programme n'est disponible. */
  noCandidates: string;
  /** Message du menu quand la recherche ne renvoie rien. */
  noResults: string;
  /** Libellé du champ « code ». */
  codeLabel: string;
  /** Invite du champ « code ». */
  codePlaceholder: string;
  /** Libellé du champ « titre ». */
  titleLabel: string;
  /** Invite du champ « titre ». */
  titlePlaceholder: string;
  /** Bouton « annuler ». */
  cancel: string;
  /** Bouton « enregistrer ». */
  save: string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Message d'erreur quand l'enregistrement échoue. */
  saveError: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
}
