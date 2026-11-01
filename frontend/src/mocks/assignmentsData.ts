import type { Assignment, AssignmentStudentRow } from '../types/domain.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Date limite à 23 h 59, `days` jours après `now` : les maquettes restent à jour dans le temps. */
function dueIn(now: Date, days: number): string {
  const due = new Date(now.getTime() + days * DAY_MS);
  due.setHours(23, 59, 0, 0);
  return due.toISOString();
}

/** Devoirs fictifs d'un cours (#252). Contenu d'exemple, jamais affiché en production. */
export function demoAssignments(courseId: number, now: Date): Assignment[] {
  const base = {
    courseId,
    isPublished: true,
    publishedBy: 'Prof. Tremblay',
    studentCount: 32,
    gradedCount: 0,
    submittedCount: 0,
  };
  // Ids dérivés du cours : un devoir ouvert dans un cours n'existe pas dans un autre.
  const id = (n: number) => courseId * 100 + n;
  return [
    {
      ...base,
      id: id(7),
      title: 'Devoir 7 : Graphes',
      instructions: 'Parcours en largeur et en profondeur.',
      isPublished: false,
      publishedBy: undefined,
      expectedFormats: [],
      files: [],
    },
    {
      ...base,
      id: id(6),
      title: 'Devoir 6 : Arbres AVL',
      instructions:
        "Implémentez un arbre AVL en Java, avec l'insertion, la suppression et les rotations.\n\nRemettez une archive .zip contenant votre code et un court rapport.",
      dueAt: dueIn(now, 21),
      weight: 20,
      expectedFormats: ['ZIP'],
      files: [],
    },
    {
      ...base,
      id: id(5),
      title: 'Devoir 5 : Listes chaînées',
      instructions:
        "Implémentez une liste doublement chaînée en Java, avec les opérations d'insertion, de suppression et de recherche.\n\nPensez aux cas limites : liste vide, un seul nœud, insertion en tête et en queue.\n\nRemettez une archive .zip contenant votre code et un court rapport de deux pages.",
      dueAt: dueIn(now, 4),
      weight: 20,
      expectedFormats: ['PDF', 'ZIP'],
      files: [
        { name: 'enonce-devoir-5.pdf', size: '240 Ko' },
        { name: 'squelette-liste.zip', size: '18 Ko' },
      ],
      submittedCount: 24,
      gradedCount: 10,
    },
    {
      ...base,
      id: id(4),
      title: 'Devoir 4 : Tri et complexité',
      instructions: 'Comparez trois algorithmes de tri et justifiez leur complexité.',
      dueAt: dueIn(now, -14),
      weight: 15,
      expectedFormats: ['PDF'],
      files: [],
      submittedCount: 32,
      gradedCount: 32,
      submission: {
        fileName: 'devoir4-lavoie.pdf',
        submittedAt: new Date(now.getTime() - 15 * DAY_MS).toISOString(),
        late: false,
        grade: '17 / 20',
      },
    },
    {
      ...base,
      id: id(3),
      title: 'Devoir 3 : Piles et files',
      instructions: 'Implémentez une pile et une file à partir de la même structure.',
      dueAt: dueIn(now, -28),
      weight: 15,
      expectedFormats: [],
      files: [],
      submittedCount: 30,
      gradedCount: 12,
      submission: {
        fileName: 'devoir3-lavoie.zip',
        submittedAt: new Date(now.getTime() - 27 * DAY_MS).toISOString(),
        late: true,
      },
    },
  ];
}

const FIRST_NAMES = ['Camille', 'Thomas', 'Léa', 'Samuel', 'Maya', 'Noah', 'Alice', 'Félix'];
const LAST_NAMES = ['Lavoie', 'Bélanger', 'Morin', 'Roy', 'Tran', 'Gagnon'];

/**
 * Remises fictives d'un devoir, cohérentes avec ses compteurs : les premiers étudiants sont
 * corrigés, puis remis, puis manquants. Une remise n'est en retard que si la date limite est passée.
 */
export function demoStudentRows(assignment: Assignment, now: Date): AssignmentStudentRow[] {
  const due = assignment.dueAt ? new Date(assignment.dueAt) : now;
  const isOver = due < now;
  return Array.from({ length: assignment.studentCount }, (_, index) => {
    const first = FIRST_NAMES[index % FIRST_NAMES.length];
    // Décalage à chaque tour de prénoms : un nom complet ne revient pas, même pour 48 étudiants.
    const last = LAST_NAMES[(index + Math.floor(index / 24)) % LAST_NAMES.length];
    const studentName = `${first} ${last}`;
    if (index >= assignment.submittedCount) return { studentName, status: 'missing' };

    const isLate = isOver && index >= assignment.submittedCount - 3;
    const submittedAt = new Date(
      isLate
        ? due.getTime() + (index + 1) * HOUR_MS
        : Math.min(due.getTime(), now.getTime()) - (index + 1) * HOUR_MS
    ).toISOString();
    const fileName = `${assignment.title.split(' :')[0].replace(' ', '').toLowerCase()}-${last.toLowerCase()}.zip`;
    if (index < assignment.gradedCount) {
      return { studentName, status: 'graded', submittedAt, fileName, grade: `${14 + (index % 7)} / 20` };
    }
    return { studentName, status: isLate ? 'late' : 'submitted', submittedAt, fileName };
  });
}
