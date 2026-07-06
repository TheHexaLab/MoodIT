import { type Program } from './ProgramMenu';
import { type Role } from '../../types/domain.ts';

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
  /**
   * Le rôle de l'utilisateur DANS un programme a changé (User_Program_Role) : ses menus
   * d'actions administratives se re-gatent. `roleName` = rôle le plus élevé restant
   * ('Administrateur' / 'Enseignant') ou null (plus aucun rôle dans ce programme).
   */
  onProgramRoleChange?: (
    programId: number,
    roleName: 'Administrateur' | 'Enseignant' | null
  ) => void;
  /**
   * Les rôles GLOBAUX de l'utilisateur (User_Role) ont changé : il re-dérive ses droits
   * plateforme (admin général / gardien). `roles` = liste globale à jour.
   */
  onGlobalRolesChange?: (roles: Role[]) => void;
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
