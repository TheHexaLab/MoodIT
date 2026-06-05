import { type Program } from '../components/ProgramMenu/ProgramMenu';
import { type Course } from '../components/CourseMenu/CourseMenu';

export interface DemoProgram extends Program {
  courses: Course[];
}

/**
 * Donnees de demonstration du dashboard.
 * Elles simulent un melange de donnees UI et backend pour valider
 * le comportement plug-and-play des composants de menu.
 */
export const dashboardProgramsMock: DemoProgram[] = [
  {
    id: '1',
    label: 'Genie Informatique',
    courses: [
      {
        id_course: 'course-inf-1',
        code: 'GIF123',
        title: 'Introduction a la programmation',
        quizzes: [],
        textChannels: [],
        forums: [],
      },
      {
        id_course: 'course-inf-2',
        code: 'GIF456',
        title: 'Genie logiciel',
        quizzes: [{ id_quiz: 'c-1', title: 'quiz-semaine-1' }],
        textChannels: [
          { id_text_channel: 'c-2', name: 'general' },
          { id_text_channel: 'c-3', name: 'ressources' },
        ],
        forums: [{ id_forum: 'c-4', title: 'questions-lab' }],
      },
      {
        id: 'course-inf-3',
        name: 'IFT287 - Structures de donnees',
        channels: [
          { id: 'c-9', name: 'quiz-chapitre-2', type: 'quiz' },
          { id: 'c-10', name: 'entraide', type: 'forum' },
        ],
      },
    ],
  },
  {
    id: '2',
    label: 'Genie Electrique',
    courses: [
      {
        id_course: 'course-ele-1',
        code: 'GEL300',
        title: 'Circuits numeriques',
        textChannels: [{ id_text_channel: 'c-4', name: 'annonces' }],
        forums: [{ id_forum: 'c-5', title: 'forum-labo' }],
      },
      {
        id_course: 'course-ele-2',
        code: 'GEL201',
        title: 'Electronique',
        quizzes: [],
        textChannels: [],
        forums: [],
      },
    ],
  },
  {
    id: '3',
    label: 'Education',
    logoUrl: 'https://www.svgrepo.com/show/532061/moon-stars.svg',
    courses: [
      {
        id_course: 'course-edu-1',
        code: 'EDU101',
        title: 'Fondements pedagogiques',
        textChannels: [{ id_text_channel: 'c-6', name: 'annonces' }],
      },
      {
        id_course: 'course-edu-2',
        code: 'EDU245',
        title: 'Evaluation des apprentissages',
        quizzes: [{ id_quiz: 'c-7', title: 'quiz-diagnostic' }],
        forums: [{ id_forum: 'c-8', title: 'forum-reflexion' }],
      },
    ],
  },
  {
    id: '4',
    label: 'Rick Astley',
    logoUrl:
      'https://variety.com/wp-content/uploads/2021/07/Rick-Astley-Never-Gonna-Give-You-Up.png?w=1000&h=667&crop=1',
    courses: [],
  },
];
