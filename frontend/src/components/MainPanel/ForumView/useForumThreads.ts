import { useCallback, useEffect, useRef, useState } from 'react';
import { type ForumAuthor, type ForumPost } from './forumThreads';

/** Valeur synchrone ou asynchrone : un callback d'API peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/** Valeur d'un vote : +1 (up), -1 (down) ou 0 (retire). */
export type VoteValue = 1 | 0 | -1;

/**
 * Chargement des sujets d'un forum (API-ready, GET). Renvoie l'arbre des posts
 * (sujets racines + reponses imbriquees).
 */
export type FetchThreadsHandler = (forumId: number) => MaybePromise<ForumPost[]>;

/**
 * Publication d'un post (API-ready, POST). Reçoit le contenu, l'id du parent
 * (`post_parent_id`, null pour un sujet racine) et le `clientPostId` (nonce).
 * Peut renvoyer le post persiste (id reel + meme `client_post_id`) qui remplacera
 * la version optimiste.
 */
export type CreatePostHandler = (
  content: string,
  parentId: number | null,
  clientPostId: string,
  title?: string
) => MaybePromise<ForumPost | void>;

/** Modification d'un post (API-ready, PATCH). Peut renvoyer le post persiste. */
export type EditPostHandler = (postId: number, content: string) => MaybePromise<ForumPost | void>;

/** Suppression d'un post (API-ready, DELETE). Cote BD : ON DELETE CASCADE du sous-fil. */
export type DeletePostHandler = (postId: number) => MaybePromise<unknown>;

/** Vote sur un post (API-ready). `value` ∈ {-1, 0, 1} (0 = retrait du vote). */
export type VotePostHandler = (postId: number, value: VoteValue) => MaybePromise<unknown>;

/** Handlers d'evenements temps reel pousses par le socket pour un forum. */
export interface IncomingForumHandlers {
  /** Un post a ete cree (par soi ou un autre utilisateur), sous `parentId`. */
  onPost: (post: ForumPost, parentId: number | null) => void;
  /** Un post a ete modifie. */
  onEdit: (postId: number, content: string) => void;
  /** Un post a ete supprime (avec son sous-fil). */
  onDelete: (postId: number) => void;
  /** Un vote a change : `userId` met son vote a `value` sur `postId`. */
  onVote: (postId: number, userId: number, value: VoteValue) => void;
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
  editPost: (postId: number, content: string) => Promise<boolean>;
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
function mapPost(posts: ForumPost[], id: number, updater: (post: ForumPost) => ForumPost): ForumPost[] {
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
    .map((post) => (post.replies?.length ? { ...post, replies: removeFromTree(post.replies, id) } : post));
}

/** Insere `reply` sous `parentId` (ou a la racine si null). */
function insertIntoTree(posts: ForumPost[], parentId: number | null, reply: ForumPost): ForumPost[] {
  if (parentId === null) return [...posts, reply];
  return posts.map((post) => {
    if (post.id === parentId) return { ...post, replies: [...(post.replies ?? []), reply] };
    if (post.replies?.length) return { ...post, replies: insertIntoTree(post.replies, parentId, reply) };
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

/** Trouve un post par `client_post_id` (reconciliation de l'echo WS). */
function findByClientId(posts: ForumPost[], clientId: string): ForumPost | undefined {
  for (const post of posts) {
    if (post.client_post_id === clientId) return post;
    if (post.replies?.length) {
      const found = findByClientId(post.replies, clientId);
      if (found) return found;
    }
  }
  return undefined;
}

/** Id du parent du post `id` (null si racine, undefined si introuvable). */
function findParentId(posts: ForumPost[], id: number, parent: number | null = null): number | null | undefined {
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
  const votes = post.votes.filter((v) => v.user_id !== userId);
  if (value !== 0) votes.push({ user_id: userId, value });
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

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const fetchRef = useRef(onFetchThreads);
  useEffect(() => {
    fetchRef.current = onFetchThreads;
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
    const post = findInTree(threads, postId);
    if (!post) return;
    const current = post.votes.find((v) => v.user_id === currentUser.id)?.value ?? 0;
    const nextValue: VoteValue = current === direction ? 0 : direction;
    const previousVotes = post.votes;
    setThreads((prev) => mapPost(prev, postId, (p) => withVote(p, currentUser.id, nextValue)));

    runMutation(
      () => (onVotePost ? onVotePost(postId, nextValue) : undefined),
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
      client_post_id: clientId,
      title: trimmedTitle || undefined,
      content: trimmedContent,
      created_at: new Date().toISOString(),
      author: currentUser,
      votes: [],
      replies: [],
    };
    setThreads((prev) => insertIntoTree(prev, null, optimistic)); // sujet racine

    setError(null);
    setPending(true);
    try {
      const saved = onCreatePost
        ? await onCreatePost(trimmedContent, null, clientId, trimmedTitle || undefined)
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
      client_post_id: clientId,
      content: trimmed,
      created_at: new Date().toISOString(),
      author: currentUser,
      votes: [],
      replies: [],
    };
    setThreads((prev) => insertIntoTree(prev, parentId, optimistic));

    setError(null);
    setPending(true);
    try {
      const saved = onCreatePost ? await onCreatePost(trimmed, parentId, clientId) : undefined;
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
      setThreads((prev) => removeFromTree(prev, tempId)); // rollback
      setError("La réponse n'a pas pu être publiée. Réessayez.");
      return false;
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  async function editPost(postId: number, content: string): Promise<boolean> {
    const trimmed = content.trim();
    const target = findInTree(threads, postId);
    if (!target || !trimmed || trimmed === target.content) return false;

    const previousContent = target.content;
    setThreads((prev) => mapPost(prev, postId, (p) => ({ ...p, content: trimmed })));

    setError(null);
    try {
      const saved = onEditPost ? await onEditPost(postId, trimmed) : undefined;
      if (!mountedRef.current) return true;
      // Le serveur fait foi sur le contenu final.
      if (saved) setThreads((prev) => mapPost(prev, postId, () => saved));
      return true;
    } catch {
      if (!mountedRef.current) return false;
      setThreads((prev) => mapPost(prev, postId, (p) => ({ ...p, content: previousContent }))); // rollback
      setError("La modification n'a pas pu être enregistrée. Réessayez.");
      return false;
    }
  }

  function deletePost(postId: number) {
    const target = findInTree(threads, postId);
    if (!target) return;
    const parentId = findParentId(threads, postId) ?? null;

    setThreads((prev) => removeFromTree(prev, postId));

    runMutation(
      () => (onDeletePost ? onDeletePost(postId) : undefined),
      () => setThreads((prev) => insertIntoTree(prev, parentId, target)),
      "La suppression n'a pas pu être effectuée. Réessayez."
    );
  }

  // ── Entrants WebSocket : refs stables pour pouvoir s'abonner dans un effet.
  const applyIncomingPost = useCallback((post: ForumPost, parentId: number | null) => {
    setThreads((prev) => {
      const existing =
        findInTree(prev, post.id) ??
        (post.client_post_id ? findByClientId(prev, post.client_post_id) : undefined);
      if (existing) return mapPost(prev, existing.id, () => post); // reconcilie l'optimiste
      return insertIntoTree(prev, parentId, post);
    });
  }, []);

  const applyIncomingEdit = useCallback((postId: number, content: string) => {
    setThreads((prev) => mapPost(prev, postId, (p) => ({ ...p, content })));
  }, []);

  const applyIncomingDelete = useCallback((postId: number) => {
    setThreads((prev) => removeFromTree(prev, postId));
  }, []);

  const applyIncomingVote = useCallback((postId: number, userId: number, value: VoteValue) => {
    setThreads((prev) => mapPost(prev, postId, (p) => withVote(p, userId, value)));
  }, []);

  useEffect(() => {
    if (!socket) return;
    return socket.subscribe(forumId, {
      onPost: applyIncomingPost,
      onEdit: applyIncomingEdit,
      onDelete: applyIncomingDelete,
      onVote: applyIncomingVote,
    });
  }, [socket, forumId, applyIncomingPost, applyIncomingEdit, applyIncomingDelete, applyIncomingVote]);

  return {
    threads,
    loading,
    loadError,
    reload: () => void reload(),
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
