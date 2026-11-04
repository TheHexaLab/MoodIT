import type { Assignment, AssignmentStudentRow, AssignmentTeam } from '../types/domain.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Date limite à 23 h 59, `days` jours après `now` : les maquettes restent à jour dans le temps. */
function dueIn(now: Date, days: number): string {
  const due = new Date(now.getTime() + days * DAY_MS);
  due.setHours(23, 59, 0, 0);
  return due.toISOString();
}

/**
 * Date limite dans la semaine en cours (du dimanche au samedi) : `ahead` jours après `now`, sans
 * dépasser samedi, à l'heure donnée. L'horaire montre ainsi des remises dès son ouverture (#258).
 */
function dueThisWeek(now: Date, ahead: number, hour: number, minute = 0): string {
  const due = new Date(now);
  due.setDate(due.getDate() + Math.min(ahead, 6 - due.getDay()));
  due.setHours(hour, minute, 0, 0);
  return due.toISOString();
}

/** Date limite la semaine prochaine, au jour (0 = dimanche) et à l'heure donnés. */
function dueNextWeek(now: Date, weekday: number, hour: number, minute = 0): string {
  const due = new Date(now);
  due.setDate(due.getDate() - due.getDay() + 7 + weekday);
  due.setHours(hour, minute, 0, 0);
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
  // Les remises varient d'un cours à l'autre : un cours sur deux remet la semaine prochaine, et
  // jour et heure se décalent.
  const nextWeek = courseId % 2 === 0;
  const dayShift = Math.floor(courseId / 2) % 2;
  const hourShift = courseId % 4;
  /** `ahead` jours après aujourd'hui cette semaine, ou le jour `weekday` la semaine prochaine. */
  const due = (ahead: number, weekday: number, hour: number, minute = 0) =>
    nextWeek
      ? dueNextWeek(now, weekday + dayShift, hour, minute)
      : dueThisWeek(now, ahead + dayShift, hour, minute);
  return [
    {
      ...base,
      id: id(9),
      title: 'Laboratoire 2 : Tables de hachage',
      instructions:
        'En équipe de trois, comparez deux stratégies de résolution de collisions et présentez vos mesures.',
      dueAt: due(2, 1, 12 + hourShift),
      weight: 10,
      expectedFormats: ['.pdf'],
      files: [],
      teamSize: 3,
      teamFormation: 'students',
    },
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
      dueAt: due(1, 3, 17 + hourShift, 30),
      weight: 30,
      expectedFormats: ['.zip', '.pdf'],
      files: [{ name: 'enonce-projet.pdf', size: '410 Ko' }],
      teamSize: 4,
      teamFormation: 'teacher',
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
      dueAt: due(1, 4, 20 + hourShift),
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
    const studentName = `${first} ${last}`;
    const id = assignment.id * 100 + index;
    if (index >= assignment.submittedCount) {
      return { id, studentName, status: 'missing', files: [] };
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
        status: 'graded',
        submittedAt,
        files,
        grade: `${14 + (index % 7)} / 20`,
        comment: 'Bon travail, code clair.',
      };
    }
    return { id, studentName, status: isLate ? 'late' : 'submitted', submittedAt, files };
  });
}

/** L'étudiant fictif : c'est lui qui rejoint et quitte les équipes dans les maquettes. */
export const DEMO_STUDENT = 'Camille Lavoie';

/** Les étudiants fictifs du cours. */
export function demoCourseStudents(): string[] {
  return Array.from({ length: 32 }, (_, index) => {
    const first = FIRST_NAMES[index % FIRST_NAMES.length];
    const last = LAST_NAMES[(index + Math.floor(index / 24)) % LAST_NAMES.length];
    return `${first} ${last}`;
  });
}

/**
 * Équipes fictives de départ. Formées par le prof : tout le cours est réparti, et l'étudiant fictif
 * est dans l'Équipe 3. Formées par les étudiants : quelques équipes commencées, sans lui.
 */
export function demoTeams(assignment: Assignment): AssignmentTeam[] {
  const size = assignment.teamSize ?? 0;
  const names = demoCourseStudents();
  const team = (index: number, members: string[]): AssignmentTeam => ({
    id: assignment.id * 100 + index,
    name: `Équipe ${index + 1}`,
    members,
  });
  if (assignment.teamFormation === 'students') {
    return [
      team(0, names.slice(1, 1 + size)),
      team(1, names.slice(1 + size, size + 3)),
      team(2, names.slice(size + 3, size + 4)),
    ];
  }
  [names[0], names[size * 2]] = [names[size * 2], names[0]];
  return Array.from({ length: Math.ceil(names.length / size) }, (_, index) =>
    team(index, names.slice(index * size, (index + 1) * size))
  );
}
