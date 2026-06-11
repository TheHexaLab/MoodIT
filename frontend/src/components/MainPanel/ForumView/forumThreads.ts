import { type ForumPost, type PostVote, type User } from '../../../types/domain.ts';

// Entités ré-exportées depuis le modèle de domaine (source unique : src/types/domain.ts).
export type { ForumPost };
/** Auteur d'un post = User (mêmes colonnes que User_). Alias de compat. */
export type ForumAuthor = User;
/** Vote d'un post. Alias de compat. */
export type ForumVote = PostVote;

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
 * Un forum sans mock dedie (ex. nouvellement cree) est renvoye VIDE.
 */
export function getMockForumThreads(forumId: number): ForumPost[] {
  return (THREADS_BY_FORUM[forumId] ?? []).map(toShallow);
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
  return [];
}
