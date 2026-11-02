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
      id: id(8),
      title: 'Projet : Réseau social en graphe',
      instructions:
        "En équipe, modélisez un réseau social avec un graphe et implémentez la recherche d'amis communs.\n\nRemettez votre code et un rapport de cinq pages.",
      dueAt: dueIn(now, 10),
      weight: 30,
      expectedFormats: ['.zip', '.pdf'],
      files: [{ name: 'enonce-projet.pdf', size: '410 Ko' }],
      teamSize: 4,
      team: {
        name: 'Équipe 3',
        members: ['Camille Lavoie', 'Thomas Bélanger', 'Léa Morin', 'Samuel Roy'],
      },
      studentCount: 8,
      submittedCount: 5,
      gradedCount: 2,
      submission: {
        fileNames: ['projet-equipe3.zip', 'rapport-equipe3.pdf'],
        submittedAt: new Date(now.getTime() - DAY_MS).toISOString(),
        late: false,
        submittedBy: 'Thomas Bélanger',
      },
    },
    {
      ...base,
      id: id(6),
      title: 'Devoir 6 : Arbres AVL',
      instructions:
        "Implémentez un arbre AVL en Java, avec l'insertion, la suppression et les rotations.\n\nRemettez une archive .zip contenant votre code et un court rapport.",
      dueAt: dueIn(now, 21),
      weight: 20,
      expectedFormats: ['.zip'],
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
      expectedFormats: ['.pdf', '.zip'],
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
      expectedFormats: ['.pdf'],
      files: [],
      submittedCount: 32,
      gradedCount: 32,
      submission: {
        fileNames: ['devoir4-lavoie.pdf'],
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
        fileNames: ['devoir3-lavoie.zip', 'rapport-lavoie.pdf'],
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
    const isTeam = assignment.teamSize != null;
    const studentName = isTeam ? `Équipe ${index + 1}` : `${first} ${last}`;
    // Membres fictifs : des noms consécutifs de la liste, jusqu'à la taille maximale.
    const members = isTeam
      ? Array.from({ length: assignment.teamSize ?? 0 }, (_, member) => {
          const position = index * (assignment.teamSize ?? 0) + member;
          const memberLast = LAST_NAMES[(position + Math.floor(position / 24)) % LAST_NAMES.length];
          return `${FIRST_NAMES[position % FIRST_NAMES.length]} ${memberLast}`;
        })
      : undefined;
    const id = assignment.id * 100 + index;
    if (index >= assignment.submittedCount) {
      return { id, studentName, members, status: 'missing', files: [] };
    }

    const isLate = isOver && index >= assignment.submittedCount - 3;
    const submittedAt = new Date(
      isLate
        ? due.getTime() + (index + 1) * HOUR_MS
        : Math.min(due.getTime(), now.getTime()) - (index + 1) * HOUR_MS
    ).toISOString();
    const prefix = assignment.title.split(' :')[0].replace(' ', '').toLowerCase();
    const suffix = isTeam ? `equipe${index + 1}` : last.toLowerCase();
    // Un exemple sur trois remet aussi un rapport ; un sur six ajoute une capture.
    const files = [
      { name: `${prefix}-${suffix}.zip`, size: `${120 + index * 7} Ko` },
      ...(index % 3 === 1 ? [{ name: `rapport-${suffix}.pdf`, size: `${300 + index * 11} Ko` }] : []),
      ...(index % 6 === 1 ? [{ name: `capture-${suffix}.png`, size: `${80 + index} Ko` }] : []),
    ];
    if (index < assignment.gradedCount) {
      return {
        id,
        studentName,
        members,
        status: 'graded',
        submittedAt,
        files,
        grade: `${14 + (index % 7)} / 20`,
        comment: 'Bon travail, code clair.',
      };
    }
    return { id, studentName, members, status: isLate ? 'late' : 'submitted', submittedAt, files };
  });
}
