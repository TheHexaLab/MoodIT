import { useCallback, useEffect, useRef, useState } from 'react';
import { type ForumAuthor, type ForumPost } from './forumThreads';
import { type AuthorUpdate } from '../../../types/domain.ts';

/** Valeur synchrone ou asynchrone : un callback d'API peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/** Valeur d'un vote : +1 (up), -1 (down) ou 0 (retire). */
export type VoteValue = 1 | 0 | -1;

/**
 * Chargement des sujets d'un forum (API-ready, GET). Renvoie UNIQUEMENT les sujets
 * RACINES (sans leurs reponses) ; chaque racine porte `replyCount`. Les reponses
 * sont ensuite chargees paresseusement, branche par branche (voir `FetchRepliesHandler`).
 */
export type FetchThreadsHandler = (forumId: number) => MaybePromise<ForumPost[]>;

/**
 * Chargement des reponses DIRECTES (enfants immediats) d'un post (API-ready, GET).
 * Appele quand l'utilisateur deplie un fil : on ne descend qu'un seul niveau a la
 * fois. Chaque enfant renvoye porte a son tour `replyCount` pour ses propres reponses.
 */
export type FetchRepliesHandler = (forumId: number, postId: number) => MaybePromise<ForumPost[]>;

/**
 * Publication d'un post (API-ready, POST). Reçoit l'id du forum ('Thread') cible, le
 * contenu, l'id du parent (`postParentId`, null pour un sujet racine) et le
 * `clientPostId` (nonce). Peut renvoyer le post persiste (id reel + meme
 * `clientPostId`) qui remplacera la version optimiste.
 */
export type CreatePostHandler = (
  forumId: number,
  content: string,
  parentId: number | null,
  clientPostId: string,
  title?: string
) => MaybePromise<ForumPost | void>;

/** Modification d'un post (API-ready, PATCH). `title` = nouveau titre d'un sujet racine
 *  (absent pour une réponse). Peut renvoyer le post persiste. */
export type EditPostHandler = (
  postId: number,
  content: string,
  title?: string
) => MaybePromise<ForumPost | void>;

/** Suppression d'un post (API-ready, DELETE). Cote BD : ON DELETE CASCADE du sous-fil. */
export type DeletePostHandler = (postId: number) => MaybePromise<unknown>;

/** Vote sur un post (API-ready). `value` ∈ {-1, 0, 1} (0 = retrait du vote). */
export type VotePostHandler = (postId: number, value: VoteValue) => MaybePromise<unknown>;

/** Handlers d'evenements temps reel pousses par le socket pour un forum. */
export interface IncomingForumHandlers {
  /** Un post a ete cree (par soi ou un autre utilisateur), sous `parentId`. */
  onPost: (post: ForumPost, parentId: number | null) => void;
  /** Un post a ete modifie (contenu, et titre pour un sujet racine). */
  onEdit: (postId: number, content: string, title?: string | null) => void;
  /** Un post a ete supprime (avec son sous-fil). */
  onDelete: (postId: number) => void;
  /** Un vote a change : `userId` met son vote a `value` sur `postId`. */
  onVote: (postId: number, userId: number, value: VoteValue) => void;
  /** Un utilisateur a modifie son profil (GLOBAL) : maj de l'auteur des posts, par id. */
  onUserUpdate?: (user: AuthorUpdate) => void;
}

/**
 * Contrat minimal d'un socket temps reel (forum). Une seule methode : s'abonner
 * aux evenements d'un forum. L'implementation (WebSocket natif, socket.io, mock…)
 * est fournie par le parent ; le hook ne connait que cette interface.
 */
export interface ForumSocket {
  subscribe: (forumId: number, handlers: IncomingForumHandlers) => () => void;
}

interface UseForumThreadsParams {
  forumId: number;
  initialThreads: ForumPost[];
  currentUser: ForumAuthor;
  onFetchThreads?: FetchThreadsHandler;
  onFetchReplies?: FetchRepliesHandler;
  onCreatePost?: CreatePostHandler;
  onEditPost?: EditPostHandler;
  onDeletePost?: DeletePostHandler;
  onVotePost?: VotePostHandler;
  socket?: ForumSocket;
}

export interface ForumThreadsApi {
  /** Source de verite unique : l'arbre des sujets (racines + reponses). */
  threads: ForumPost[];
  /** Chargement initial en cours. */
  loading: boolean;
  /** Erreur de chargement initial (null = aucune) ; voir `reload`. */
  loadError: string | null;
  /** Relance le chargement (bouton « Réessayer »). */
  reload: () => void;
  /** Posts dont les reponses directes sont en cours de chargement (lazy). */
  loadingReplies: Set<number>;
  /** Posts dont le chargement des reponses a echoue (bouton « Réessayer » de branche). */
  replyErrors: Set<number>;
  /**
   * Charge (paresseusement) les reponses DIRECTES d'un post et les fusionne dans
   * l'arbre. Resout a `true` en cas de succes, `false` si echec.
   */
  loadReplies: (postId: number) => Promise<boolean>;
  /** Une publication async est-elle en cours ? */
  pending: boolean;
  /** Message d'erreur de la derniere operation (null = aucune). */
  error: string | null;
  /** Efface l'erreur courante. */
  clearError: () => void;

  // ── Actions utilisateur : optimiste + rollback + persistance via les callbacks.
  /** (Dé)vote un post : re-cliquer la meme direction annule le vote. */
  vote: (postId: number, direction: 1 | -1) => void;
  /** Publie un nouveau sujet racine (titre + contenu) ; `true`=succes, `false`=echec. */
  addThread: (title: string, content: string) => Promise<boolean>;
  /** Publie une reponse ; resout a `true` en cas de succes, `false` si echec. */
  addReply: (parentId: number, content: string) => Promise<boolean>;
  /** Modifie un post (optimiste) ; resout a `true` en cas de succes, `false` si echec. */
  editPost: (postId: number, content: string, title?: string) => Promise<boolean>;
  /** Supprime un post et son sous-fil (optimiste). */
  deletePost: (postId: number) => void;

  // ── Événements ENTRANTS : a brancher sur la couche WebSocket.
  applyIncomingPost: (post: ForumPost, parentId: number | null) => void;
  applyIncomingEdit: (postId: number, content: string) => void;
  applyIncomingDelete: (postId: number) => void;
  applyIncomingVote: (postId: number, userId: number, value: VoteValue) => void;
}

// ─── Helpers d'arbre (purs, immutables). ───

/** Remplace (immutablement) le post `id` par `updater(post)`, partout dans l'arbre. */
function mapPost(
  posts: ForumPost[],
  id: number,
  updater: (post: ForumPost) => ForumPost
): ForumPost[] {
  return posts.map((post) => {
    if (post.id === id) return updater(post);
    if (post.replies?.length) return { ...post, replies: mapPost(post.replies, id, updater) };
    return post;
  });
}

/** Retire le post `id` (et son sous-fil) de l'arbre. */
function removeFromTree(posts: ForumPost[], id: number): ForumPost[] {
  return posts
    .filter((post) => post.id !== id)
    .map((post) =>
      post.replies?.length ? { ...post, replies: removeFromTree(post.replies, id) } : post
    );
}

/** Ajuste (de `delta`) le compteur de reponses directes du post `parentId`. */
function adjustReplyCount(posts: ForumPost[], parentId: number | null, delta: number): ForumPost[] {
  if (parentId === null) return posts;
  return mapPost(posts, parentId, (post) => ({
    ...post,
    replyCount: Math.max(0, (post.replyCount ?? post.replies?.length ?? 0) + delta),
  }));
}

/** Insere `reply` sous `parentId` (ou a la racine si null). */
function insertIntoTree(
  posts: ForumPost[],
  parentId: number | null,
  reply: ForumPost
): ForumPost[] {
  if (parentId === null) return [...posts, reply];
  return posts.map((post) => {
    if (post.id === parentId) return { ...post, replies: [...(post.replies ?? []), reply] };
    if (post.replies?.length)
      return { ...post, replies: insertIntoTree(post.replies, parentId, reply) };
    return post;
  });
}

/** Trouve un post par id dans l'arbre. */
function findInTree(posts: ForumPost[], id: number): ForumPost | undefined {
  for (const post of posts) {
    if (post.id === id) return post;
    if (post.replies?.length) {
      const found = findInTree(post.replies, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Trouve un post par `clientPostId` (reconciliation de l'echo WS). */
function findByClientId(posts: ForumPost[], clientId: string): ForumPost | undefined {
  for (const post of posts) {
    if (post.clientPostId === clientId) return post;
    if (post.replies?.length) {
      const found = findByClientId(post.replies, clientId);
      if (found) return found;
    }
  }
  return undefined;
}

/** Id du parent du post `id` (null si racine, undefined si introuvable). */
function findParentId(
  posts: ForumPost[],
  id: number,
  parent: number | null = null
): number | null | undefined {
  for (const post of posts) {
    if (post.id === id) return parent;
    if (post.replies?.length) {
      const result = findParentId(post.replies, id, post.id);
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

/** Pose (ou retire si value=0) le vote de `userId` sur un post. */
function withVote(post: ForumPost, userId: number, value: VoteValue): ForumPost {
  const votes = post.votes.filter((v) => v.userId !== userId);
  if (value !== 0) votes.push({ userId: userId, value });
  return { ...post, votes };
}

/** Genere un identifiant client (nonce) pour reconcilier optimiste ↔ echo serveur. */
function generateClientId(seq: number): string {
  return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${seq}`;
}

/**
 * Source de verite unique des sujets d'un forum : un seul arbre qui agrege
 * l'historique, les actions optimistes (vote / reponse / edition / suppression,
 * avec rollback) et — une fois branche — les evenements WebSocket entrants.
 *
 * (Le composant est remonte via une `key` au changement de forum, donc l'etat
 * est reinitialise depuis `initialThreads` a chaque forum.)
 */
export function useForumThreads({
  forumId,
  initialThreads,
  currentUser,
  onFetchThreads,
  onFetchReplies,
  onCreatePost,
  onEditPost,
  onDeletePost,
  onVotePost,
  socket,
}: UseForumThreadsParams): ForumThreadsApi {
  const [threads, setThreads] = useState<ForumPost[]>(initialThreads);
  const [loading, setLoading] = useState<boolean>(Boolean(onFetchThreads));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Chargement paresseux des branches : suivi par post (id).
  const [loadingReplies, setLoadingReplies] = useState<Set<number>>(new Set());
  const [replyErrors, setReplyErrors] = useState<Set<number>>(new Set());

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const fetchRef = useRef(onFetchThreads);
  const fetchRepliesRef = useRef(onFetchReplies);
  useEffect(() => {
    fetchRef.current = onFetchThreads;
    fetchRepliesRef.current = onFetchReplies;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const fetchThreads = fetchRef.current;
    if (!fetchThreads) return;
    setLoading(true);
    setLoadError(null);
    // On repart d'un arbre neuf : les etats de chargement paresseux des branches
    // (qui referencent l'ancien arbre) ne sont plus valides.
    setLoadingReplies(new Set());
    setReplyErrors(new Set());
    try {
      const fetched = await fetchThreads(forumId);
      if (!mountedRef.current) return;
      setThreads(fetched);
    } catch {
      if (!mountedRef.current) return;
      setLoadError('Impossible de charger les sujets. Réessayez.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [forumId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const clearError = useCallback(() => setError(null), []);

  /**
   * Charge les reponses DIRECTES d'un post (un seul niveau) et les fusionne dans
   * l'arbre. Ne descend jamais recursivement : chaque enfant reste replie et
   * chargera ses propres reponses a son tour quand on le depliera.
   */
  const loadReplies = useCallback(async (postId: number): Promise<boolean> => {
    // Post pas encore persisté (id temporaire négatif) : il ne peut avoir aucune réponse
    // côté serveur. On évite un GET /posts/-1 qui répondrait 404 ; ses réponses sont [].
    if (postId < 0) {
      setThreads((prev) => mapPost(prev, postId, (post) => ({ ...post, replies: [], replyCount: 0 })));
      return true;
    }
    const fetchReplies = fetchRepliesRef.current;
    setReplyErrors((prev) => {
      if (!prev.has(postId)) return prev;
      const next = new Set(prev);
      next.delete(postId);
      return next;
    });
    setLoadingReplies((prev) => new Set(prev).add(postId));
    try {
      const children = fetchReplies ? await fetchReplies(forumId, postId) : [];
      if (!mountedRef.current) return true;
      setThreads((prev) =>
        mapPost(prev, postId, (post) => ({
          ...post,
          replies: children,
          replyCount: children.length,
        }))
      );
      return true;
    } catch {
      if (!mountedRef.current) return false;
      setReplyErrors((prev) => new Set(prev).add(postId));
      return false;
    } finally {
      if (mountedRef.current) {
        setLoadingReplies((prev) => {
          const next = new Set(prev);
          next.delete(postId);
          return next;
        });
      }
    }
  }, []);

  /** Joue une mutation async avec garde anti-demontage ; rollback + erreur si echec. */
  async function runMutation(
    perform: () => MaybePromise<unknown>,
    rollback: () => void,
    errorMessage: string
  ) {
    setError(null);
    try {
      await perform();
    } catch {
      if (!mountedRef.current) return;
      rollback();
      setError(errorMessage);
    }
  }

  function vote(postId: number, direction: 1 | -1) {
    // Post pas encore persisté (id temporaire négatif) : aucune action serveur
    // possible tant que la création n'est pas confirmée (cf. reconciliation).
    if (postId < 0) return;
    const post = findInTree(threads, postId);
    if (!post) return;
    const current = post.votes.find((v) => v.userId === currentUser.id)?.value ?? 0;
    const nextValue: VoteValue = current === direction ? 0 : direction;
    const previousVotes = post.votes;
    // Affichage optimiste : `nextValue` (0 = vote retiré localement).
    setThreads((prev) => mapPost(prev, postId, (p) => withVote(p, currentUser.id, nextValue)));

    runMutation(
      // API : on envoie la DIRECTION cliquée (±1), pas `nextValue`. Le backend applique
      // le toggle (même direction re-cliquée → annule) et la table Vote interdit 0.
      () => (onVotePost ? onVotePost(postId, direction) : undefined),
      () => setThreads((prev) => mapPost(prev, postId, (p) => ({ ...p, votes: previousVotes }))),
      "Votre vote n'a pas pu être enregistré. Réessayez."
    );
  }

  async function addThread(title: string, content: string): Promise<boolean> {
    const trimmedContent = content.trim();
    if (!trimmedContent) return false;
    const trimmedTitle = title.trim();

    const clientId = generateClientId(++seqRef.current);
    const tempId = -seqRef.current; // id temporaire negatif, unique pour la cle React
    const optimistic: ForumPost = {
      id: tempId,
      clientPostId: clientId,
      title: trimmedTitle || undefined,
      content: trimmedContent,
      createdAt: new Date().toISOString(),
      author: currentUser,
      votes: [],
      replies: [],
    };
    setThreads((prev) => insertIntoTree(prev, null, optimistic)); // sujet racine

    setError(null);
    setPending(true);
    try {
      const saved = onCreatePost
        ? await onCreatePost(forumId, trimmedContent, null, clientId, trimmedTitle || undefined)
        : undefined;
      if (!mountedRef.current) return true;
      if (saved) {
        setThreads((prev) =>
          mapPost(prev, tempId, () => ({ ...saved, replies: saved.replies ?? [] }))
        );
      }
      return true;
    } catch {
      if (!mountedRef.current) return false;
      setThreads((prev) => removeFromTree(prev, tempId)); // rollback
      setError("Le sujet n'a pas pu être publié. Réessayez.");
      return false;
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  async function addReply(parentId: number, content: string): Promise<boolean> {
    const trimmed = content.trim();
    if (!trimmed) return false;

    const clientId = generateClientId(++seqRef.current);
    const tempId = -seqRef.current; // id temporaire negatif, unique pour la cle React
    const optimistic: ForumPost = {
      id: tempId,
      clientPostId: clientId,
      content: trimmed,
      createdAt: new Date().toISOString(),
      author: currentUser,
      votes: [],
      replies: [],
      replyCount: 0,
    };
    // La branche est supposee deja chargee (le composant la charge avant de poster) :
    // on insere l'optimiste et on incremente le compteur de reponses du parent.
    setThreads((prev) => adjustReplyCount(insertIntoTree(prev, parentId, optimistic), parentId, 1));

    setError(null);
    setPending(true);
    try {
      const saved = onCreatePost
        ? await onCreatePost(forumId, trimmed, parentId, clientId)
        : undefined;
      if (!mountedRef.current) return true;
      // Reconciliation : on remplace l'optimiste par la version persistante.
      if (saved) {
        setThreads((prev) =>
          mapPost(prev, tempId, () => ({ ...saved, replies: saved.replies ?? [] }))
        );
      }
      return true;
    } catch {
      if (!mountedRef.current) return false;
      // rollback : on retire l'optimiste et on annule l'incrementation du compteur.
      setThreads((prev) => adjustReplyCount(removeFromTree(prev, tempId), parentId, -1));
      setError("La réponse n'a pas pu être publiée. Réessayez.");
      return false;
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  async function editPost(postId: number, content: string, title?: string): Promise<boolean> {
    const trimmed = content.trim();
    const trimmedTitle = title?.trim();
    // id temporaire négatif = post pas encore confirmé côté serveur : on bloque.
    if (postId < 0) return false;
    const target = findInTree(threads, postId);
    // Contenu OBLIGATOIRE ; titre obligatoire s'il est fourni (sujet racine).
    if (!target || !trimmed || (trimmedTitle !== undefined && !trimmedTitle)) return false;
    // Rien à enregistrer si contenu ET titre sont inchangés.
    const contentSame = trimmed === target.content;
    const titleSame = trimmedTitle === undefined || trimmedTitle === (target.title ?? '');
    if (contentSame && titleSame) return false;

    const previousContent = target.content;
    const previousTitle = target.title;
    setThreads((prev) =>
      mapPost(prev, postId, (p) => ({
        ...p,
        content: trimmed,
        ...(trimmedTitle !== undefined ? { title: trimmedTitle } : {}),
      }))
    );

    setError(null);
    try {
      const saved = onEditPost ? await onEditPost(postId, trimmed, trimmedTitle) : undefined;
      if (!mountedRef.current) return true;
      // Le serveur fait foi sur le contenu final, mais le PATCH ne renvoie pas le
      // sous-arbre : on fusionne ses champs en PRESERVANT les reponses deja chargees
      // et le compteur (sinon on replierait/perdrait la branche du post edite).
      if (saved) {
        setThreads((prev) =>
          mapPost(prev, postId, (p) => ({
            ...p,
            ...saved,
            replies: saved.replies ?? p.replies,
            replyCount: saved.replyCount ?? p.replyCount,
          }))
        );
      }
      return true;
    } catch {
      if (!mountedRef.current) return false;
      setThreads((prev) =>
        mapPost(prev, postId, (p) => ({ ...p, content: previousContent, title: previousTitle }))
      ); // rollback contenu + titre
      setError("La modification n'a pas pu être enregistrée. Réessayez.");
      return false;
    }
  }

  function deletePost(postId: number) {
    // id temporaire négatif = post pas encore confirmé côté serveur : on bloque.
    if (postId < 0) return;
    const target = findInTree(threads, postId);
    if (!target) return;
    const parentId = findParentId(threads, postId) ?? null;

    setThreads((prev) => adjustReplyCount(removeFromTree(prev, postId), parentId, -1));

    runMutation(
      () => (onDeletePost ? onDeletePost(postId) : undefined),
      () =>
        setThreads((prev) => adjustReplyCount(insertIntoTree(prev, parentId, target), parentId, 1)),
      "La suppression n'a pas pu être effectuée. Réessayez."
    );
  }

  // ── Entrants WebSocket : refs stables pour pouvoir s'abonner dans un effet.
  const applyIncomingPost = useCallback((post: ForumPost, parentId: number | null) => {
    setThreads((prev) => {
      const existing =
        findInTree(prev, post.id) ??
        (post.clientPostId ? findByClientId(prev, post.clientPostId) : undefined);
      // Reconciliation de l'optimiste : on fusionne l'echo serveur en PRESERVANT les
      // reponses deja chargees et le compteur (l'echo d'une creation ne porte pas le
      // sous-arbre), pour ne pas replier ni vider une branche deja depliee.
      if (existing) {
        return mapPost(prev, existing.id, (p) => ({
          ...p,
          ...post,
          replies: post.replies ?? p.replies,
          replyCount: post.replyCount ?? p.replyCount,
        }));
      }
      // Branche parente pas encore chargee (lazy) : on n'insere pas l'enfant (on
      // ne montrerait qu'une partie du fil) ; on incremente juste le compteur. La
      // reponse sera recuperee quand l'utilisateur depliera la branche.
      if (parentId !== null && findInTree(prev, parentId)?.replies === undefined) {
        return adjustReplyCount(prev, parentId, 1);
      }
      return adjustReplyCount(insertIntoTree(prev, parentId, post), parentId, 1);
    });
  }, []);

  const applyIncomingEdit = useCallback(
    (postId: number, content: string, title?: string | null) => {
      setThreads((prev) =>
        mapPost(prev, postId, (p) => ({
          ...p,
          content,
          // title fourni (sujet racine) → on l'applique ; null/undefined (réponse) → inchangé.
          ...(title != null ? { title } : {}),
        }))
      );
    },
    []
  );

  const applyIncomingDelete = useCallback((postId: number) => {
    setThreads((prev) => {
      const parentId = findParentId(prev, postId) ?? null;
      return adjustReplyCount(removeFromTree(prev, postId), parentId, -1);
    });
  }, []);

  const applyIncomingVote = useCallback((postId: number, userId: number, value: VoteValue) => {
    setThreads((prev) => mapPost(prev, postId, (p) => withVote(p, userId, value)));
  }, []);

  // Profil modifie (GLOBAL) : on remplace prenom/nom/couleur/username de l'auteur sur
  // tous les posts de cet utilisateur dans l'arbre (racines ET reponses imbriquees).
  const applyIncomingUserUpdate = useCallback((user: AuthorUpdate) => {
    const updateAuthors = (posts: ForumPost[]): ForumPost[] =>
      posts.map((p) => ({
        ...p,
        author:
          p.author.id === user.id
            ? {
                ...p.author,
                username: user.username,
                firstName: user.firstName,
                lastName: user.lastName,
                avatarColor: user.avatarColor,
              }
            : p.author,
        replies: p.replies ? updateAuthors(p.replies) : p.replies,
      }));
    setThreads((prev) => updateAuthors(prev));
  }, []);

  useEffect(() => {
    if (!socket) return;
    return socket.subscribe(forumId, {
      onPost: applyIncomingPost,
      onEdit: applyIncomingEdit,
      onDelete: applyIncomingDelete,
      onVote: applyIncomingVote,
      onUserUpdate: applyIncomingUserUpdate,
    });
  }, [
    socket,
    forumId,
    applyIncomingPost,
    applyIncomingEdit,
    applyIncomingDelete,
    applyIncomingVote,
    applyIncomingUserUpdate,
  ]);

  return {
    threads,
    loading,
    loadError,
    reload: () => void reload(),
    loadingReplies,
    replyErrors,
    loadReplies,
    pending,
    error,
    clearError,
    vote,
    addThread,
    addReply,
    editPost,
    deletePost,
    applyIncomingPost,
    applyIncomingEdit,
    applyIncomingDelete,
    applyIncomingVote,
  };
}
