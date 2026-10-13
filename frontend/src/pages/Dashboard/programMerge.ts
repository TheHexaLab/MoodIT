import { type DemoProgram } from './dashboardApi.ts';

/**
 * Liste de programmes rechargée (fetchPrograms, toujours SANS cours) fusionnée avec l'état courant :
 * on CONSERVE les cours déjà chargés. Sans ça, une réponse de programmes arrivant APRÈS celle des
 * cours (deux chargements concurrents) remplaçait la liste par des programmes vides : « Ce
 * programme n'a pas de cours » jusqu'au rafraîchissement, le chargeur de cours ne se relançant pas
 * (même programme actif). Constaté surtout dans Edge (ordre d'arrivée des réponses).
 */
export function mergeProgramsKeepingCourses(
  current: DemoProgram[],
  fresh: DemoProgram[]
): DemoProgram[] {
  return fresh.map((program) => {
    const loaded = current.find((p) => p.id === program.id)?.courses;
    return loaded && loaded.length > 0 ? { ...program, courses: loaded } : program;
  });
}
