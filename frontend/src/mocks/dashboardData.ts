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
 * Forum ; leur fType ('Discussion' = canal, 'Thread' = forum) les distingue.
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
        quizzes: [{ id: 1, title: 'quiz-semaine-1', position: 0 }],
        forums: [
          {
            id: 1,
            title: 'general',
            fType: 'Discussion',
            position: 0,
            messages: [
              {
                id: 1,
                content: 'Salut tout le monde ! Bienvenue dans le canal du cours 👋',
                createdAt: '2026-06-05T09:02:00',
                author: {
                  id: 1,
                  username: 'admin',
                  firstName: 'Admin',
                  lastName: 'Admin',
                  avatarColor: '#8b1a1a',
                },
              },
              {
                id: 2,
                content: 'Est-ce que le TP de la semaine 1 est deja disponible ?',
                createdAt: '2026-06-05T09:15:00',
                author: {
                  id: 2,
                  username: 'rosie1234',
                  firstName: 'Rosie',
                  lastName: 'HG a;lskdjf; alksdjf;aklsdjf; klasjdf;kl ajsd;fkljasd;klfj as;kdjhf;askdlj f;aslkdjf ;lkasdjf; asd',
                  avatarColor: '#0a5cc0',
                },
              },
              {
                id: 3,
                content: 'Oui, il est dans la section ressources. La remise est vendredi prochain.',
                createdAt: '2026-06-06T14:18:00',
                postParentId: 2,
                author: {
                  id: 3,
                  username: 'mich1234',
                  firstName: 'Mich',
                  lastName: 'Normand',
                  avatarColor: '#1a6e3c',
                },
              },
              {
                id: 4,
                content: 'Merci ! Quelqu\'un veut former une equipe pour reviser avant le quiz ?',
                createdAt: '2026-06-07T09:24:00',
                author: {
                  id: 2,
                  username: 'rosie1234',
                  firstName: 'Rosie',
                  lastName: 'HG',
                  avatarColor: '#0a5cc0',
                },
              },
              {
                id: 5,
                content: 'Je suis partant 🙌 On peut se voir a la biblio demain midi.',
                createdAt: '2026-06-07T11:31:00',
                author: {
                  id: 3,
                  username: 'mich1234',
                  firstName: 'Mich',
                  lastName: 'Normand',
                  avatarColor: '#1a6e3c',
                },
              },
              {
                id: 6,
                content: 'Petit rappel : la remise du TP1 est ce vendredi a 23 h 59 ⏰',
                createdAt: '2026-06-08T08:05:00',
                author: {
                  id: 1,
                  username: 'admin',
                  firstName: 'Admin',
                  lastName: 'Admin',
                  avatarColor: '#8b1a1a',
                },
              },
              {
                id: 7,
                content:
                  "Merci pour le rappel ! J'en profite pour resumer ce qu'on a convenu hier a la biblio, " +
                  "histoire que tout le monde soit sur la meme longueur d'onde. On se separe le travail en trois " +
                  'parties : Rosie prend la modelisation de la base de donnees et le diagramme entite-association, ' +
                  'moi je m\'occupe de la couche d\'acces aux donnees et des requetes, et il nous reste a trouver ' +
                  'quelqu\'un pour la partie interface. Pour la remise, on vise mercredi soir comme echeance interne ' +
                  'afin de garder deux jours de marge pour les tests et la relecture avant la vraie date limite. ' +
                  "Si quelqu'un voit un probleme avec cette repartition ou veut echanger une section, dites-le " +
                  'avant ce soir pour qu\'on puisse ajuster. N\'hesitez pas aussi a pousser vos branches au fur et ' +
                  'a mesure plutot que de tout garder en local jusqu\'a la fin 🙏',
                createdAt: '2026-06-08T08:42:00',
                author: {
                  id: 2,
                  username: 'rosie1234',
                  firstName: 'Rosie',
                  lastName: 'HG',
                  avatarColor: '#0a5cc0',
                },
              },
            ],
          },
          { id: 2, title: 'ressources', fType: 'Discussion', position: 1 },
          { id: 3, title: 'questions-lab', fType: 'Thread', position: 2 },
        ],
      },
      {
        id: 3,
        code: 'IFT287',
        title: 'Structures de donnees',
        quizzes: [{ id: 2, title: 'quiz-chapitre-2', position: 0 }],
        forums: [{ id: 4, title: 'entraide', fType: 'Thread', position: 0 }],
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
          { id: 5, title: 'annonces', fType: 'Discussion', position: 0 },
          { id: 6, title: 'forum-labo', fType: 'Thread', position: 1 },
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
        forums: [{ id: 7, title: 'annonces', fType: 'Discussion', position: 0 }],
      },
      {
        id: 7,
        code: 'GCI301',
        title: 'Hydraulique',
        quizzes: [{ id: 3, title: 'quiz-diagnostic', position: 0 }],
        forums: [{ id: 8, title: 'forum-reflexion', fType: 'Thread', position: 0 }],
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
