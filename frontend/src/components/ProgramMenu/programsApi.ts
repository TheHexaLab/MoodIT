import { type Program } from './ProgramMenu';

/**
 * Contrat « API + temps réel » de ProgramMenu (miroir de CourseMenu).
 *
 * Approche LÉGÈRE : Dashboard reste propriétaire de la liste des programmes de
 * l'utilisateur. Ce fichier ne définit que les *contrats* à remplir le jour du
 * branchement backend :
 *   - chargement de la liste des programmes de l'utilisateur (GET) ;
 *   - réception temps réel (WebSocket) des évènements programme / abonnement.
 *
 * Le câblage concret (mock → vrai backend) vit chez le parent (Dashboard) :
 * voir `services/appSocket.ts` (façade `programs`) et `ProgramMenu/HANDOFF.md`.
 */

/** Valeur synchrone ou asynchrone : un callback d'API peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Chargement de la liste des programmes de l'utilisateur connecté (GET). Côté UI,
 * pilote les états `loading` / `loadError` / `reload` rendus par ProgramMenu.
 */
export type FetchProgramsHandler = () => MaybePromise<Program[]>;

/**
 * Évènements temps réel poussés par le serveur pour un UTILISATEUR (sa liste
 * d'abonnements). `upsert` couvre création / renommage de programme et adhésion ;
 * `remove` couvre suppression de programme et désabonnement (ou exclusion).
 */
export interface IncomingProgramHandlers {
  /** Un programme a été créé / modifié, ou l'utilisateur vient d'y adhérer. */
  onProgramUpsert: (program: Program) => void;
  /** Un programme a été supprimé, ou l'utilisateur l'a quitté / en a été retiré. */
  onProgramRemove: (programId: number) => void;
}

/**
 * Contrat minimal du socket des programmes : s'abonner aux évènements de la liste
 * d'abonnements d'un utilisateur. L'implémentation (WebSocket natif, mock…) est
 * fournie par le parent. Granularité : un abonnement par utilisateur connecté.
 */
export interface ProgramsSocket {
  /** S'abonne aux évènements de l'utilisateur ; renvoie la fonction de désabonnement. */
  subscribe: (userId: number, handlers: IncomingProgramHandlers) => () => void;
}
