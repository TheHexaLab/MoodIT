import {
  dashboardProgramsMock,
  dashboardEmptyCourseMock,
  type DemoProgram,
} from '../../mocks/dashboardData.ts';

export type DashboardDataSource = 'empty' | 'empty-course' | 'demo' | 'real';

/**
 * Point de bascule unique pour le dashboard.
 * Change la valeur ici pour passer d'un mode a l'autre pendant le developpement.
 * - empty:        aucun programme, aucun cours, aucun canal
 * - empty-course: programmes avec cours mais aucun canal
 * - demo:         donnees de demonstration completes
 * - real:         branchement futur sur l'API/BDD
 */
export const dashboardDataSource: DashboardDataSource = 'demo';

/**
 * Retourne les données à utiliser selon le mode choisi.
 * Le mode `real` est volontairement branché à vide pour l'instant,
 * afin de garder un point d'extension clair pour l'API.
 */
export function getDashboardPrograms(): DemoProgram[] {
  switch (dashboardDataSource) {
    case 'demo':
      return dashboardProgramsMock;
    case 'empty-course':
      return dashboardEmptyCourseMock;
    case 'real':
      return [];
    case 'empty':
    default:
      return [];
  }
}
