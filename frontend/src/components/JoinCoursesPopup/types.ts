/** Types et libellés du JoinCoursesPopup (rejoindre des cours d'un programme). */

/** Valeur synchrone ou asynchrone : les callbacks peuvent retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Cours rejoignable d'un programme. Forme légère : seulement code + titre (les
 * canaux/quiz/forums sont chargés à l'entrée dans le programme).
 */
export interface JoinableCourse {
  id: number;
  code: string;
  title: string;
}

/** Tous les textes affichés par le composant (surcharge via la prop `labels`). */
export interface JoinCoursesPopupLabels {
  /** Titre du popup. */
  title: string;
  /** Sous-titre (reçoit le nom du programme). */
  subtitle: (programName: string) => string;
  /** Invite de la barre de recherche. */
  searchPlaceholder: string;
  /** Message quand le programme n'a aucun cours rejoignable. */
  noCourses: string;
  /** Message quand la recherche ne renvoie rien. */
  noResults: string;
  /** Bouton « annuler ». */
  cancel: string;
  /** Bouton de validation (« rejoindre »). */
  join: string;
  /** Message d'erreur de chargement des cours. */
  loadError: string;
  /** Bouton « réessayer » de l'état d'erreur de chargement. */
  retry: string;
  /** Message d'erreur d'enregistrement (adhésion). */
  saveError: string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
}
