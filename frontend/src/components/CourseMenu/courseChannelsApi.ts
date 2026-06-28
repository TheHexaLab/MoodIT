import { type ItemChange, type MaybePromise } from '../SectionEditorPopup/SectionEditorPopup';
import { type Course } from './CourseMenu';

/**
 * Contrat « API + temps réel » de CourseMenu (miroir de ChannelView / ForumView).
 *
 * Approche LÉGÈRE : Dashboard reste propriétaire de l'état des cours. Ce fichier
 * ne définit que les *contrats* à remplir le jour du branchement backend :
 *   - chargement de la liste des cours d'un programme (GET) ;
 *   - persistance d'une modification de section (déjà via `onSectionChange`) ;
 *   - réception temps réel (WebSocket) des évènements cours / section.
 *
 * Le câblage concret (mock → vrai backend) vit chez le parent (Dashboard) :
 * voir `services/appSocket.ts` (façade `courses`) et `CourseMenu/HANDOFF.md`.
 */

export type { ItemChange, MaybePromise } from '../SectionEditorPopup/SectionEditorPopup';

/**
 * Chargement de la liste des cours d'un programme (API-ready, GET). Reçoit l'id
 * du programme actif et renvoie ses cours (sections incluses). Côté UI, pilote
 * les états `loading` / `loadError` / `reload` rendus par CourseMenu.
 */
export type FetchCoursesHandler = (programId: number) => MaybePromise<Course[]>;

/**
 * Évènements temps réel poussés par le serveur pour un PROGRAMME (toutes les
 * « rooms » cours du programme partagent un seul abonnement).
 */
export interface IncomingCourseHandlers {
  /** Une modification de section distante (canal/quiz/forum ajouté, renommé, supprimé, réordonné). */
  onSectionChange: (courseId: number, sectionType: string, change: ItemChange) => void;
  /** Un cours a été créé ou modifié (insert/replace dans le programme). */
  onCourseUpsert: (course: Course) => void;
  /** Un cours a été supprimé du programme. */
  onCourseDelete: (courseId: number) => void;
  /** Un quiz a été ajouté au cours (→ rafraîchit la liste). */
  onQuizCreated?: (courseId: number, quizId: number) => void;
  /** Un quiz du cours a été modifié (→ rafraîchit la liste + bannière si ouvert). */
  onQuizUpdated?: (courseId: number, quizId: number) => void;
  /** Les quiz du cours ont été réordonnés (→ rafraîchit la liste). */
  onQuizReordered?: (courseId: number) => void;
  /** Un quiz du cours a été supprimé (→ retrait de la liste, fermeture de la vue ouverte). */
  onQuizDeleted?: (courseId: number, quizId: number) => void;
  /**
   * Reconnexion WebSocket après coupure : des évènements ont pu être manqués → on
   * resynchronise (recharge les cours du programme, donc canaux/quiz/forums).
   */
  onResync?: () => void;
}

/**
 * Contrat minimal du socket des cours : s'abonner aux évènements d'un programme.
 * L'implémentation (WebSocket natif, mock…) est fournie par le parent ; le
 * consommateur ne connaît que cette interface. Granularité : un abonnement par
 * programme actif (re-`join` géré à la reconnexion par la couche socket).
 */
export interface CourseChannelsSocket {
  /** S'abonne aux évènements du programme ; renvoie la fonction de désabonnement. */
  subscribe: (programId: number, handlers: IncomingCourseHandlers) => () => void;
}
