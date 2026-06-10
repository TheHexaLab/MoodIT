import { type ChannelMessageAuthor } from '../../CourseChannelList/CourseChannelList';

/**
 * Auteur d'un post de forum (= colonnes utiles de User_).
 * On reutilise le type des messages de canal : meme table User_ en BD.
 */
export type ForumAuthor = ChannelMessageAuthor;

/**
 * Vote sur un post (≈ une ligne de la table Vote).
 * En BD : Vote.value_ ∈ {-1, 1} (CHECK), et un utilisateur ne vote qu'une seule
 * fois par post (UNIQUE(user_id, post_id)). Le SCORE d'un post = SUM(value_).
 */
export interface ForumVote {
  /** Vote.user_id : auteur du vote. */
  user_id: number;
  /** Vote.value_ : +1 (upvote) ou -1 (downvote). */
  value: 1 | -1;
}

/**
 * Sujet ou reponse d'un forum 'Thread' (≈ Post d'un Forum de f_type 'Thread').
 * Les reponses (Post.post_parent_id) sont imbriquees dans `replies`, facon
 * fil de commentaires Reddit.
 */
export interface ForumPost {
  /** Post.id */
  id: number;
  /** Post.content */
  content: string;
  /** Post.created_at (timestamp ISO). */
  created_at: string;
  /** Auteur du post. */
  author: ForumAuthor;
  /** Post.is_pinned : sujet epingle en tete de liste. */
  is_pinned?: boolean;
  /** Titre du sujet (les posts racines d'un Thread en ont un, facon Reddit). */
  title?: string;
  /** Votes du post (table Vote). Le score affiche = somme des `value_`. */
  votes: ForumVote[];
  /**
   * Reponses directes (Post enfants via post_parent_id), chargees PARESSEUSEMENT :
   * `undefined` = enfants pas encore charges (le fil n'a jamais ete deplie),
   * `[]` = charges et aucun enfant. On ne descend jamais tout l'arbre d'un coup :
   * deplier un post va chercher uniquement ses enfants immediats (voir `reply_count`).
   */
  replies?: ForumPost[];
  /**
   * Nombre de reponses DIRECTES (enfants immediats), connu des le chargement du
   * post meme si `replies` n'est pas encore charge. Sert a afficher le toggle
   * « N réponses » sans avoir a descendre le fil.
   */
  reply_count?: number;
  /**
   * Identifiant genere cote client a la publication (nonce). Renvoye par l'API et
   * par le broadcast WebSocket, il permet de dedupliquer le post optimiste de son echo.
   */
  client_post_id?: string;
}

// ─── Auteurs reutilises (inspires des seeds de init.sql). ───
// `me` = l'utilisateur connecte (mock Dashboard : id 1, « jeandubois »). Ses posts
// portent donc les actions Modifier/Supprimer. `admin` est decale a un autre id
// pour ne pas se confondre avec l'utilisateur courant.
const me: ForumAuthor = {
  id: 1,
  username: 'jeandubois',
  first_name: 'Jean',
  last_name: 'D.',
  avatar_color: '#1f4799',
};
const admin: ForumAuthor = {
  id: 10,
  username: 'admin',
  first_name: 'Admin',
  last_name: 'Admin',
  avatar_color: '#8b1a1a',
};
const rosie: ForumAuthor = {
  id: 2,
  username: 'rosie1234',
  first_name: 'Rosie',
  last_name: 'HG',
  avatar_color: '#0a5cc0',
};
const mich: ForumAuthor = {
  id: 3,
  username: 'mich1234',
  first_name: 'Mich',
  last_name: 'Normand',
  avatar_color: '#1a6e3c',
};
const lea: ForumAuthor = {
  id: 4,
  username: 'lea_tremblay',
  first_name: 'Léa',
  last_name: 'Tremblay',
  avatar_color: '#0f766e',
};
const karim: ForumAuthor = {
  id: 5,
  username: 'karim_b',
  first_name: 'Karim',
  last_name: 'Benali',
  avatar_color: '#7a4e1a',
};

/**
 * Sujets de demonstration, indexes par id de forum (Forum.id).
 * Seuls les forums de f_type 'Thread' sont rendus par ForumView ; voir les
 * mocks du dashboard (dashboardData.ts) pour le mapping id ↔ forum.
 */
const THREADS_BY_FORUM: Record<number, ForumPost[]> = {
  // Forum 3 — « questions-lab » (GIF456 · Genie logiciel).
  3: [
    {
      id: 101,
      is_pinned: true,
      title: 'À lire avant de poser une question 📌',
      content:
        '**Avant de créer un sujet**, vérifie qu\'une question similaire n\'existe pas déjà.\n\n' +
        '### À inclure dans chaque sujet\n' +
        '- le **numéro du laboratoire** concerné\n' +
        '- ton environnement : *OS* et version du compilateur\n' +
        '- le **message d\'erreur** complet\n\n' +
        'Exemple de compilation à fournir :\n\n' +
        '```bash\ngcc -Wall -g main.c -o main\n```\n\n' +
        'Pour une commande isolée, cite-la en ligne comme `valgrind ./main`.\n\n' +
        '> Les sujets bien décrits reçoivent des réponses beaucoup plus vite.\n\n' +
        'Voir le [guide de rédaction](https://example.com/guide) pour les détails.',
      created_at: '2026-06-01T08:00:00',
      author: admin,
      votes: [
        { user_id: 1, value: 1 }, // utilisateur connecte : upvote (apparait en vert)
        { user_id: 2, value: 1 },
        { user_id: 3, value: 1 },
        { user_id: 4, value: 1 },
        { user_id: 5, value: 1 },
      ],
      replies: [],
    },
    {
      id: 102,
      title: 'Erreur de segmentation dans le labo 3 (pointeurs)',
      content:
        'Mon programme compile **sans avertissement** mais plante avec un « segmentation fault » ' +
        'dès que j\'appelle `free()` sur ma liste chaînée.\n\n' +
        'Voici la boucle de libération :\n\n' +
        '```c\nwhile (node) {\n  free(node);\n  node = node->next;\n}\n```\n\n' +
        'J\'ai l\'impression de libérer deux fois le même nœud — quelqu\'un voit l\'erreur ?',
      created_at: '2026-06-07T14:12:00',
      author: me,
      votes: [
        { user_id: 3, value: 1 },
        { user_id: 4, value: 1 },
        { user_id: 5, value: 1 },
        { user_id: 10, value: 1 },
      ],
      replies: [
        {
          id: 103,
          content:
            'Classique : tu mets à jour `head` **avant** de libérer le nœud courant. ' +
            'Sauvegarde `next` AVANT le `free()` :\n\n' +
            '```c\nwhile (node) {\n  Node *next = node->next;\n  free(node);\n  node = next;\n}\n```\n\n' +
            'Et remets le pointeur à `NULL` après `free()` pour éviter le double-free.',
          created_at: '2026-06-07T14:48:00',
          author: mich,
          votes: [
            { user_id: 1, value: -1 }, // utilisateur connecte : downvote (apparait en rouge)
            { user_id: 2, value: 1 },
            { user_id: 4, value: 1 },
            { user_id: 5, value: 1 },
          ],
          replies: [
            {
              id: 104,
              content: "C'était exactement ça, merci ! 🙏 Le `next` sauvegardé avant le free() a réglé le plantage.",
              created_at: '2026-06-07T15:10:00',
              author: rosie,
              votes: [
                { user_id: 3, value: 1 },
                { user_id: 10, value: 1 },
              ],
              replies: [],
            },
          ],
        },
        {
          id: 105,
          content:
            'Petit conseil bonus : lance ton binaire sous `valgrind --leak-check=full`, il te pointe ' +
            'la ligne exacte du double-free. Indispensable pour ce labo.',
          created_at: '2026-06-07T16:02:00',
          author: me,
          votes: [
            { user_id: 2, value: 1 },
            { user_id: 3, value: 1 },
          ],
          replies: [],
        },
      ],
    },
    {
      id: 106,
      title: 'Le barème du labo 4 est-il publié ?',
      content:
        'Je ne trouve pas la grille de correction du labo 4 dans la section ressources. ' +
        'Est-ce normal ou est-ce que je cherche au mauvais endroit ?',
      created_at: '2026-06-08T09:30:00',
      author: me,
      votes: [
        { user_id: 10, value: -1 },
        { user_id: 5, value: -1 },
      ],
      replies: [
        {
          id: 107,
          content: 'Elle sera mise en ligne ce soir, on finalise la pondération des tests automatiques.',
          created_at: '2026-06-08T10:05:00',
          author: admin,
          votes: [{ user_id: 4, value: 1 }],
          replies: [],
        },
      ],
    },
    // Sujet « stress test » : longue chaine de reponses imbriquees pour voir
    // ou l'indentation du fil casse (a retirer une fois le layout valide).
    {
      id: 120,
      title: '[Test layout] Jusqu’où l’indentation tient-elle ?',
      content:
        'Fil volontairement profond pour observer le comportement de l’indentation et du filet ' +
        'vertical des réponses au fur et à mesure qu’on descend dans le fil.',
      created_at: '2026-06-08T18:00:00',
      author: karim,
      votes: [{ user_id: 2, value: 1 }],
      replies: [
        {
          id: 121,
          content: 'Niveau 1 — première réponse au sujet.',
          created_at: '2026-06-08T18:05:00',
          author: rosie,
          votes: [{ user_id: 3, value: 1 }],
          replies: [
            {
              id: 122,
              content: 'Niveau 2 — on s’enfonce d’un cran.',
              created_at: '2026-06-08T18:10:00',
              author: mich,
              votes: [{ user_id: 4, value: 1 }],
              replies: [
                {
                  id: 123,
                  content: 'Niveau 3 — toujours lisible ?',
                  created_at: '2026-06-08T18:15:00',
                  author: lea,
                  votes: [{ user_id: 5, value: 1 }],
                  replies: [
                    {
                      id: 124,
                      content: 'Niveau 4 — la largeur de texte commence à se réduire.',
                      created_at: '2026-06-08T18:20:00',
                      author: admin,
                      votes: [{ user_id: 2, value: 1 }],
                      replies: [
                        {
                          id: 125,
                          content:
                            'Niveau 5 — réponse plus longue pour tester le retour à la ligne quand la ' +
                            'colonne devient étroite : lorem ipsum dolor sit amet, consectetur adipiscing elit.',
                          created_at: '2026-06-08T18:25:00',
                          author: karim,
                          votes: [{ user_id: 3, value: 1 }],
                          replies: [
                            {
                              id: 126,
                              content: 'Niveau 6 — encore un cran.',
                              created_at: '2026-06-08T18:30:00',
                              author: rosie,
                              votes: [],
                              replies: [
                                {
                                  id: 127,
                                  content:
                                    'Niveau 7 — mot-très-long-sans-espace-pour-tester-le-débordement : ' +
                                    'pneumonoultramicroscopicsilicovolcanoconiosis.',
                                  created_at: '2026-06-08T18:35:00',
                                  author: mich,
                                  votes: [{ user_id: 10, value: -1 }],
                                  replies: [
                                    {
                                      id: 128,
                                      content: 'Niveau 8 — presque au bout.',
                                      created_at: '2026-06-08T18:40:00',
                                      author: lea,
                                      votes: [],
                                      replies: [
                                        {
                                          id: 129,
                                          content: 'Niveau 9 — un avant-dernier.',
                                          created_at: '2026-06-08T18:45:00',
                                          author: admin,
                                          votes: [],
                                          replies: [
                                            {
                                              id: 130,
                                              content:
                                                'Niveau 10 — fin du fil. Si tu lis ceci sans scroll horizontal ' +
                                                'ni texte écrasé, le layout tient. 🎉',
                                              created_at: '2026-06-08T18:50:00',
                                              author: karim,
                                              votes: [{ user_id: 2, value: 1 }],
                                              replies: [],
                                            },
                                          ],
                                        },
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                        {
                          id: 131,
                          content:
                            'Niveau 5 (bis) — je réponds directement au niveau 4, juste après la ' +
                            'longue branche ci-dessus qui descend jusqu’au niveau 10. C’est le cas ' +
                            '« retour du niveau 10 au niveau 5 » : regarde de combien de crans ' +
                            'l’indentation remonte ici.',
                          created_at: '2026-06-08T19:05:00',
                          author: me,
                          votes: [
                            { user_id: 2, value: 1 },
                            { user_id: 3, value: 1 },
                          ],
                          replies: [
                            {
                              id: 132,
                              content:
                                'Niveau 6 (bis) — et une réponse sous ce niveau 5, pour vérifier que ' +
                                'l’indentation repart bien d’ici.',
                              created_at: '2026-06-08T19:12:00',
                              author: mich,
                              votes: [{ user_id: 10, value: 1 }],
                              replies: [],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],

  // Forum 4 — « entraide » (IFT287 · Structures de donnees).
  4: [
    {
      id: 201,
      title: 'Complexité de la suppression dans un arbre AVL',
      content:
        "On dit que la suppression dans un AVL est en O(log n), mais après le retrait il peut y avoir " +
        'plusieurs rotations en remontant vers la racine. Est-ce que ça reste vraiment logarithmique ?',
      created_at: '2026-06-06T11:20:00',
      author: me,
      votes: [
        { user_id: 2, value: 1 },
        { user_id: 4, value: 1 },
        { user_id: 5, value: 1 },
      ],
      replies: [
        {
          id: 202,
          content:
            'Oui : la hauteur est en O(log n) et tu fais au plus une rotation (simple ou double) par ' +
            'niveau en remontant. Donc le nombre total de rotations est borné par la hauteur → O(log n).',
          created_at: '2026-06-06T12:00:00',
          author: lea,
          votes: [
            { user_id: 3, value: 1 },
            { user_id: 2, value: 1 },
            { user_id: 10, value: 1 },
          ],
          replies: [],
        },
      ],
    },
    {
      id: 203,
      title: 'Table de hachage : sondage linéaire vs chaînage',
      content:
        "Pour le TP, vaut-il mieux gérer les collisions par chaînage ou par sondage linéaire ? " +
        'Le sujet ne l\'impose pas et je n\'arrive pas à décider.',
      created_at: '2026-06-08T13:45:00',
      author: karim,
      votes: [{ user_id: 3, value: 1 }],
      replies: [],
    },
  ],
};

/** Quelques sujets generiques pour les forums sans mock dedie. */
const DEFAULT_THREADS: ForumPost[] = [
  {
    id: 901,
    title: 'Bienvenue sur le forum du cours 👋',
    content:
      "C'est l'endroit pour poser vos questions, partager des ressources et discuter des sujets " +
      "du cours. Soyez respectueux et votez les contributions utiles pour les faire remonter !",
    created_at: '2026-06-02T10:00:00',
    author: admin,
    is_pinned: true,
    votes: [
      { user_id: 2, value: 1 },
      { user_id: 3, value: 1 },
    ],
    replies: [],
  },
  {
    id: 902,
    title: 'Groupe d’étude pour l’examen de mi-session ?',
    content:
      "Quelqu'un serait intéressé à former un petit groupe d'étude la semaine prochaine ? " +
      'On pourrait se partager les chapitres et faire des annales ensemble.',
    created_at: '2026-06-08T16:20:00',
    author: me,
    votes: [
      { user_id: 3, value: 1 },
      { user_id: 10, value: 1 },
    ],
    replies: [
      {
        id: 903,
        content: 'Partant ! Mardi après-midi me conviendrait. 📚',
        created_at: '2026-06-08T17:02:00',
        author: me,
        votes: [{ user_id: 2, value: 1 }],
        replies: [],
      },
    ],
  },
];

/**
 * Copie « superficielle » d'un post pour le chargement paresseux : on expose le
 * nombre d'enfants immediats (`reply_count`) mais on RETIRE `replies` (les enfants
 * ne sont pas charges tant que l'utilisateur n'a pas deplie le fil).
 */
function toShallow(post: ForumPost): ForumPost {
  const { replies, ...rest } = post;
  return { ...rest, reply_count: replies?.length ?? 0 };
}

/** Recherche un post (par id) dans un arbre mock (parcours en profondeur). */
function findMockPost(posts: ForumPost[], id: number): ForumPost | undefined {
  for (const post of posts) {
    if (post.id === id) return post;
    const found = post.replies ? findMockPost(post.replies, id) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * Retourne les sujets RACINES mock d'un forum 'Thread' donne (par id de Forum),
 * sans leurs reponses (chargement paresseux : voir `getMockForumReplies`).
 * Sert de substitut a l'API tant que le backend des forums n'est pas branche.
 */
export function getMockForumThreads(forumId: number): ForumPost[] {
  return (THREADS_BY_FORUM[forumId] ?? DEFAULT_THREADS).map(toShallow);
}

/**
 * Retourne les reponses DIRECTES (enfants immediats) d'un post mock, sans leurs
 * propres sous-reponses. Substitut a l'API de chargement paresseux d'une branche.
 */
export function getMockForumReplies(postId: number): ForumPost[] {
  for (const roots of Object.values(THREADS_BY_FORUM)) {
    const found = findMockPost(roots, postId);
    if (found) return (found.replies ?? []).map(toShallow);
  }
  const found = findMockPost(DEFAULT_THREADS, postId);
  return found ? (found.replies ?? []).map(toShallow) : [];
}
