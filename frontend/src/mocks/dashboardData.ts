import { type Program } from '../components/ProgramMenu/ProgramMenu';
import { type Course } from '../components/CourseMenu/CourseMenu';

export interface DemoProgram extends Program {
  courses: Course[];
}

/**
 * Mock avec programme et cours mais aucun canal.
 * Utilise pour tester l'etat "Ce cours est vide" dans le contenu principal.
 */
export const dashboardEmptyCourseMock: DemoProgram[] = [
  {
    id: 1,
    name: 'Genie informatique',
    code: 'GIN',
    cohort: '71',
    color: '#1a6e3c',
    courses: [
      {
        id: 1,
        code: 'GIF123',
        title: 'Introduction a la programmation',
        quizzes: [],
        forums: [],
      },
      {
        id: 2,
        code: 'GIF456',
        title: 'Genie logiciel',
        quizzes: [],
        forums: [],
      },
    ],
  },
  {
    id: 2,
    name: 'Genie logiciel',
    code: 'GLO',
    cohort: '71',
    color: '#0a5cc0',
    courses: [
      {
        id: 3,
        code: 'SCI101',
        title: 'Sciences appliquees',
        quizzes: [],
        forums: [],
      },
    ],
  },
];

/**
 * Donnees de demonstration du dashboard.
 * Elles simulent un melange de donnees UI et backend pour valider
 * le comportement plug-and-play des composants de menu.
 *
 * Rappel modele : un canal et un forum sont tous deux des lignes de la table
 * Forum ; leur f_type ('Discussion' = canal, 'Thread' = forum) les distingue.
 */
export const dashboardProgramsMock: DemoProgram[] = [
  {
    id: 1,
    name: 'Genie informatique',
    code: 'GIN',
    cohort: '71',
    color: '#1a6e3c',
    courses: [
      {
        id: 1,
        code: 'GIF123',
        title: 'Introduction a la programmation',
        quizzes: [],
        forums: [],
      },
      {
        id: 2,
        code: 'GIF456',
        title: 'Genie logiciel',
        quizzes: [{ id: 1, title: 'quiz-semaine-1' }],
        forums: [
          {
            id: 1,
            title: 'general',
            f_type: 'Discussion',
            messages: [
              {
                id: 1,
                content: 'Salut tout le monde ! Bienvenue dans le canal du cours 👋',
                created_at: '2026-06-07T09:02:00',
                author: { id: 1, displayName: 'Admin', avatarColor: '#8b1a1a' },
              },
              {
                id: 2,
                content: 'Est-ce que le TP de la semaine 1 est deja disponible ?',
                created_at: '2026-06-07T09:15:00',
                author: { id: 2, displayName: 'Rosie HG', avatarColor: '#0a5cc0' },
              },
              {
                id: 3,
                content: 'Oui, il est dans la section ressources. La remise est vendredi prochain.',
                created_at: '2026-06-07T09:18:00',
                author: { id: 3, displayName: 'Mich Normand', avatarColor: '#1a6e3c' },
              },
              {
                id: 4,
                content: 'Merci ! Quelqu\'un veut former une equipe pour reviser avant le quiz ?',
                created_at: '2026-06-07T09:24:00',
                author: { id: 2, displayName: 'Rosie HG', avatarColor: '#0a5cc0' },
              },
              {
                id: 5,
                content: 'Je suis partant 🙌 On peut se voir a la biblio demain midi.',
                created_at: '2026-06-07T09:31:00',
                author: { id: 3, displayName: 'Mich Normand', avatarColor: '#1a6e3c' },
              },
            ],
          },
          { id: 2, title: 'ressources', f_type: 'Discussion' },
          { id: 3, title: 'questions-lab', f_type: 'Thread' },
        ],
      },
      {
        id: 3,
        code: 'IFT287',
        title: 'Structures de donnees',
        quizzes: [{ id: 2, title: 'quiz-chapitre-2' }],
        forums: [{ id: 4, title: 'entraide', f_type: 'Thread' }],
      },
    ],
  },
  {
    id: 2,
    name: 'Genie electrique',
    code: 'GEL',
    cohort: '71',
    color: '#8b1a1a',
    courses: [
      {
        id: 4,
        code: 'GEL300',
        title: 'Circuits numeriques',
        forums: [
          { id: 5, title: 'annonces', f_type: 'Discussion' },
          { id: 6, title: 'forum-labo', f_type: 'Thread' },
        ],
      },
      {
        id: 5,
        code: 'GEL201',
        title: 'Electronique',
        quizzes: [],
        forums: [],
      },
    ],
  },
  {
    id: 3,
    name: 'Genie civil',
    code: 'GCI',
    cohort: '71',
    color: '#3a3a7a',
    courses: [
      {
        id: 6,
        code: 'GCI201',
        title: 'Materiaux de construction',
        forums: [{ id: 7, title: 'annonces', f_type: 'Discussion' }],
      },
      {
        id: 7,
        code: 'GCI301',
        title: 'Hydraulique',
        quizzes: [{ id: 3, title: 'quiz-diagnostic' }],
        forums: [{ id: 8, title: 'forum-reflexion', f_type: 'Thread' }],
      },
    ],
  },
  {
    id: 4,
    name: 'Genie chimique',
    code: 'GCH',
    cohort: '71',
    color: '#4a7a1a',
    courses: [],
  },
  {
    // Couleur claire : le helper contrastingTextColor doit donner un texte sombre.
    id: 5,
    name: 'Genie de l\'environnement',
    code: 'GEN',
    cohort: '2024',
    color: '#f2c94c',
    courses: [],
  },
];
