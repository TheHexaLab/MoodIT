import React, { useMemo, useRef, useState } from 'react';
import styles from './ForumView.module.css';
import {
  type ChannelMessageAuthor,
  type CourseChannel,
} from '../../CourseChannelList/CourseChannelList';
import { ChannelTypeIcon } from '../../CourseChannelList/ChannelTypeIcon';
import { type Course } from '../../CourseMenu/CourseMenu';
import { getCourseDisplayLabel } from '../../CourseMenu/courseLabel';
import { contrastingTextColor } from '../../../helpers/color';
import { Reply } from '../../../assets/Reply';
import { Pencil } from '../../../assets/Pencil';
import { TrashCan } from '../../../assets/TrashCan';
import { DeleteConfirmationPopup } from '../../DeleteConfirmationPopup/DeleteConfirmationPopup';
import { ErrorPopup } from '../../ErrorPopup/ErrorPopup';
import { Spinner } from '../../Spinner/Spinner';
import { Markdown } from './Markdown';
import { MarkdownEditor } from './MarkdownEditor';
import {
  getMockForumReplies,
  getMockForumThreads,
  type ForumAuthor,
  type ForumPost,
} from './forumThreads';
import {
  useForumThreads,
  type CreatePostHandler,
  type DeletePostHandler,
  type EditPostHandler,
  type FetchRepliesHandler,
  type FetchThreadsHandler,
  type ForumSocket,
  type VoteValue,
  type VotePostHandler,
} from './useForumThreads';
import { defaultForumViewLabels } from './labels';
import { type ForumViewLabels } from './types';

// Re-export : MainPanel et Dashboard importent ces types depuis ForumView.
export type {
  FetchThreadsHandler,
  FetchRepliesHandler,
  CreatePostHandler,
  EditPostHandler,
  DeletePostHandler,
  VotePostHandler,
  ForumSocket,
  ForumViewLabels,
};

interface ForumViewProps {
  /** Cours auquel appartient le forum (contexte d'en-tete). */
  course: Course;
  /** Forum selectionne (forum de fType 'Thread' : post + reponses). */
  channel: CourseChannel;
  /** Utilisateur connecte : auteur des publications et des votes. */
  currentUser: ChannelMessageAuthor;
  /** Chargement des sujets racines (API-ready, GET). Defaut : mock local. */
  onFetchThreads?: FetchThreadsHandler;
  /** Chargement paresseux des reponses directes d'un post (API-ready, GET). Defaut : mock local. */
  onFetchReplies?: FetchRepliesHandler;
  /** Publication d'une reponse (API-ready, POST). */
  onCreatePost?: CreatePostHandler;
  /** Modification d'un post (API-ready, PATCH). */
  onEditPost?: EditPostHandler;
  /** Suppression d'un post (API-ready, DELETE). */
  onDeletePost?: DeletePostHandler;
  /** Vote sur un post (API-ready). */
  onVotePost?: VotePostHandler;
  /** Socket temps reel (optionnel) : posts / votes des autres utilisateurs. */
  socket?: ForumSocket;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<ForumViewLabels>;
}

/** Couleur d'avatar par defaut (= Program/User color par defaut en BD). */
const DEFAULT_AVATAR_COLOR = '#0a5cc0';

/**
 * Profondeur a partir de laquelle l'indentation se stabilise (plateau) : les
 * reponses plus profondes restent affichees mais cessent de deriver vers la
 * droite, pour ne pas reduire la colonne de texte a neant. Aucune limite de
 * profondeur du fil : tout reste visible inline, a n'importe quel niveau.
 */
const INDENT_PLATEAU_DEPTH = 3;

/** Sens de tri des sujets affiches. */
type SortMode = 'top' | 'recent';

/** Nom affiche d'un auteur (firstName + lastName). */
function getAuthorName(author: ForumAuthor): string {
  return `${author.firstName} ${author.lastName}`.trim() || author.username;
}

/** Deux initiales affichees dans l'avatar. */
function getInitials(author: ForumAuthor): string {
  const initials = `${author.firstName[0] ?? ''}${author.lastName[0] ?? ''}`.trim();
  return (initials || author.username[0] || '?').toUpperCase();
}

/**
 * Score d'un post : votes des autres utilisateurs (agrégat serveur `othersVoteTotal`)
 * + votes connus localement (`votes` = vote propre de l'utilisateur, éventuellement des
 * votes live d'autres). Le vote propre étant dans `votes`, il n'est PAS dans othersVoteTotal.
 */
function scoreOf(post: ForumPost): number {
  return (post.othersVoteTotal ?? 0) + post.votes.reduce((sum, vote) => sum + vote.value, 0);
}

/** Vote de l'utilisateur `userId` sur un post (depuis la table Vote). */
function userVoteOf(post: ForumPost, userId: number): VoteValue {
  return post.votes.find((vote) => vote.userId === userId)?.value ?? 0;
}

/**
 * Nombre de reponses DIRECTES (enfants immediats) d'un post. On s'appuie sur
 * `replyCount` (connu des le chargement, meme branche non depliee) et, a defaut,
 * sur les reponses deja chargees.
 */
function replyCountOf(post: ForumPost): number {
  return post.replyCount ?? post.replies?.length ?? 0;
}

/** Temps relatif court facon Reddit (« à l'instant », « il y a 3 h », « il y a 2 j »). */
function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  return new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short' }).format(date);
}

/** Compacte les grands scores (1234 → « 1,2 k »). */
function formatScore(score: number): string {
  if (Math.abs(score) < 1000) return String(score);
  return `${(score / 1000).toFixed(1).replace('.', ',')} k`;
}

/**
 * Etat 6 — vue d'un forum (fType 'Thread').
 * Discussion facon Reddit : sujets votables + fils de reponses imbriquees.
 */
const ForumView: React.FC<ForumViewProps> = ({
  course,
  channel,
  currentUser,
  onFetchThreads = getMockForumThreads,
  onFetchReplies = getMockForumReplies,
  onCreatePost,
  onEditPost,
  onDeletePost,
  onVotePost,
  socket,
  labels,
}) => {
  /** Textes affichés : défauts + surcharges éventuelles via la prop `labels`. */
  const t = { ...defaultForumViewLabels, ...labels };
  const courseLabel = getCourseDisplayLabel(course);

  // ─── Source de verite : l'arbre des sujets (API-ready + WebSocket-ready). ───
  // (Les evenements WebSocket entrants se branchent sur applyIncoming* du hook.)
  const {
    threads,
    loading,
    loadError,
    reload,
    hasMore,
    loadingMore,
    loadMore,
    loadingReplies,
    replyErrors,
    loadReplies,
    error,
    clearError,
    vote,
    addThread,
    addReply,
    editPost,
    deletePost,
  } = useForumThreads({
    forumId: channel.id,
    initialThreads: [],
    currentUser,
    onFetchThreads,
    // Le hook appelle onFetchReplies(forumId, postId) — il fournit DÉJÀ le forumId
    // (= channel.id). On passe donc le handler tel quel. Un wrapper (postId)=>... à un
    // seul paramètre écraserait le postId avec le forumId (bug : fetch /posts/{forumId}).
    onFetchReplies,
    onCreatePost,
    onEditPost,
    onDeletePost,
    onVotePost,
    socket,
  });

  // ─── Etat de la VUE uniquement (tri, repli, edition, reponse, actions). ───
  const [sort, setSort] = useState<SortMode>('top');
  // Fils ouverts : posts (sujets OU reponses) dont on affiche les enfants immediats.
  // Reddit : tout est replie par defaut ; deplier ne montre QUE le niveau suivant
  // (pas tout le sous-arbre) et declenche le chargement paresseux de la branche.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** Post en cours d'edition inline (null = aucun) + brouillon courant. */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Titre en cours d'édition (sujet racine uniquement ; vide pour une réponse).
  const [editTitleDraft, setEditTitleDraft] = useState('');
  /** Post auquel on redige une reponse (null = aucun) + brouillon courant. */
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  /** Post dont on demande confirmation de suppression (null = aucun). */
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  /** Post dont les actions sont ouvertes au tap (mobile, sans survol). */
  const [activeActionsId, setActiveActionsId] = useState<number | null>(null);
  /** Redaction d'un nouveau sujet (remplace la liste) + brouillons titre/contenu. */
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  /** Publication du nouveau sujet en cours (spinner dans le bouton Publier). */
  const [publishing, setPublishing] = useState(false);
  /** Conteneur scrollable des sujets : permet de remonter au formulaire inline. */
  const bodyRef = useRef<HTMLDivElement>(null);

  /** Vote courant de l'utilisateur connecte sur un post. */
  function getUserVote(post: ForumPost): VoteValue {
    return userVoteOf(post, currentUser.id);
  }

  /** Score affiche d'un post (somme des votes de la table Vote). */
  function getScore(post: ForumPost): number {
    return scoreOf(post);
  }

  /**
   * Deplie / replie un fil. Au premier depliage d'une branche dont les enfants ne
   * sont pas encore charges, on declenche le chargement paresseux (un seul niveau).
   */
  function toggleReplies(post: ForumPost) {
    const willOpen = !expanded.has(post.id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(post.id)) next.delete(post.id);
      else next.add(post.id);
      return next;
    });
    if (willOpen && post.replies === undefined && !loadingReplies.has(post.id)) {
      void loadReplies(post.id);
    }
  }

  /**
   * Recharge les sujets (bouton « Réessayer »). On vide aussi les fils ouverts :
   * l'arbre repart a zero (racines seules), les anciens ids deplies ne pointent
   * plus sur des branches chargees.
   */
  function handleReload() {
    setExpanded(new Set());
    reload();
  }

  /** Infinite scroll : charge des sujets plus anciens quand on approche du bas de la liste. */
  function handleBodyScroll() {
    const body = bodyRef.current;
    if (!body || !hasMore || loadingMore) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 120) {
      loadMore();
    }
  }

  /** L'utilisateur connecte est-il l'auteur du post ? (debloque modifier/supprimer). */
  function isOwn(post: ForumPost): boolean {
    return post.author.id === currentUser.id;
  }

  /** Ouvre l'editeur de reponse sous un post (ferme une edition en cours). */
  function startReply(post: ForumPost) {
    cancelEdit();
    setReplyingTo(post.id);
    setReplyDraft('');
  }

  function cancelReply() {
    setReplyingTo(null);
    setReplyDraft('');
  }

  /** Publie une reponse (optimiste via le hook) ; restaure le composer si echec. */
  async function submitReply(post: ForumPost) {
    const content = replyDraft.trim();
    if (!content) return;
    setReplyingTo(null);
    setReplyDraft('');
    // On s'assure que la nouvelle reponse sera visible (branche depliee).
    setExpanded((prev) => new Set(prev).add(post.id));
    // La branche doit etre chargee avant d'y inserer l'optimiste : sinon on n'aurait
    // affiche que la nouvelle reponse, en masquant les enfants deja existants.
    if (post.replies === undefined && !loadingReplies.has(post.id)) {
      await loadReplies(post.id);
    }
    const ok = await addReply(post.id, content);
    if (!ok) {
      setReplyingTo(post.id);
      setReplyDraft(content);
    }
  }

  function startEdit(post: ForumPost) {
    setConfirmDeleteId(null);
    setEditingId(post.id);
    setEditDraft(post.content);
    setEditTitleDraft(post.title ?? '');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
    setEditTitleDraft('');
  }

  /**
   * Valide la modification inline (optimiste via le hook) ; rouvre l'editeur si echec.
   * `isThread` = sujet racine → le titre est editable et OBLIGATOIRE (comme le contenu).
   */
  async function submitEdit(post: ForumPost, isThread: boolean) {
    const content = editDraft.trim();
    const title = editTitleDraft.trim();
    // Rien de vide (le bouton est deja desactive, filet de securite).
    if (!content || (isThread && !title)) return;
    cancelEdit();
    const ok = await editPost(post.id, content, isThread ? title : undefined);
    if (!ok) {
      // Échec : on rouvre l'editeur avec la saisie pour pouvoir reessayer.
      setEditingId(post.id);
      setEditDraft(content);
      if (isThread) setEditTitleDraft(title);
    }
  }

  /** Tap sur un post (mobile) : ouvre/ferme son panneau d'actions flottant. */
  function toggleActions(postId: number) {
    setActiveActionsId((prev) => (prev === postId ? null : postId));
  }

  /** Ouvre le formulaire de nouveau sujet (remplace la liste). */
  function startCompose() {
    if (composing) {
      return;
    }
    setComposing(true);
    setNewTitle('');
    setNewContent('');
    // Le formulaire s'affiche en tete de la liste : on remonte pour le rendre visible.
    bodyRef.current?.scrollTo({ top: 0 });
  }

  function cancelCompose() {
    setComposing(false);
    setNewTitle('');
    setNewContent('');
    setPublishing(false);
  }

  /**
   * Publie le nouveau sujet : on reste sur le formulaire avec un spinner dans le
   * bouton tant que la requete tourne. On ne revient a la liste qu'en cas de succes ;
   * en cas d'echec, le formulaire reste ouvert avec la saisie (+ ErrorPopup).
   */
  async function publishNewThread() {
    if (publishing) return;
    const title = newTitle.trim();
    const content = newContent.trim();
    if (!title || !content) return;
    setPublishing(true);
    const ok = await addThread(title, content);
    setPublishing(false);
    if (ok) {
      setComposing(false);
      setNewTitle('');
      setNewContent('');
    }
  }

  // Sujets racines tries : epingles d'abord, puis selon le mode choisi.
  const visibleThreads = useMemo(() => {
    const compare = (a: ForumPost, b: ForumPost): number => {
      if (Boolean(a.isPinned) !== Boolean(b.isPinned)) return a.isPinned ? -1 : 1;
      if (sort === 'recent') {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return getScore(b) - getScore(a);
    };
    return [...threads].sort(compare);
  }, [threads, sort]);

  // Les helpers ci-dessous retournent du JSX et sont APPELES (renderX(...)),
  // non montes comme des composants (<X/>), pour ne pas remonter l'arbre a
  // chaque vote — ils referment sur l'etat (votes, fils ouverts) du rendu courant.

  /** Contrôle de vote (fleche haut / score / fleche bas) partage sujets & reponses. */
  function renderVoteControl(post: ForumPost, compact = false) {
    const userVote = getUserVote(post);
    const score = getScore(post);
    // On ne peut pas voter pour sa propre publication.
    const own = isOwn(post);
    const ownTitle = own ? t.ownVoteTitle : undefined;
    return (
      <div role={`${!compact ? 'vertical' : 'horizontal'}-vote-actions`}>
        <button
          type="button"
          aria-label={t.voteUp}
          aria-pressed={userVote === 1}
          disabled={own}
          title={ownTitle}
          onClick={(event) => {
            event.stopPropagation();
            vote(post.id, 1);
          }}
        >
          <Arrow direction="up" />
        </button>
        <span role={userVote === 1 ? 'up-voted' : userVote === -1 ? 'down-voted' : undefined}>
          {formatScore(score)}
        </span>
        <button
          type="button"
          aria-label={t.voteDown}
          aria-pressed={userVote === -1}
          disabled={own}
          title={ownTitle}
          onClick={(event) => {
            event.stopPropagation();
            vote(post.id, -1);
          }}
        >
          <Arrow direction="down" />
        </button>
      </div>
    );
  }

  /** En-tete « avatar · auteur · temps » partage sujets & reponses. */
  function renderByline(post: ForumPost) {
    const color = post.author.avatarColor ?? DEFAULT_AVATAR_COLOR;
    return (
      <div role="header">
        <span role="avatar" style={{ background: color, color: contrastingTextColor(color) }}>
          <span>{getInitials(post.author)}</span>
        </span>
        <span role="author">{getAuthorName(post.author)}</span>
        <span role="separator" aria-hidden="true">
          •
        </span>
        <span role="time">{formatRelativeTime(post.createdAt)}</span>
        {post.isPinned && <span role="pin-indicator">{t.pinned}</span>}
      </div>
    );
  }

  /** Editeur Markdown inline (modification d'un post). */
  function renderEditor(post: ForumPost, isThread: boolean) {
    return (
      <>
        {/* Titre editable uniquement pour un sujet racine ; obligatoire (disableSubmit). */}
        {isThread && (
          <input
            type="text"
            role="edit-title"
            value={editTitleDraft}
            onChange={(event) => setEditTitleDraft(event.target.value)}
            placeholder={t.newThreadTitle}
            aria-label={t.newThreadTitle}
            maxLength={128}
          />
        )}
        <MarkdownEditor
          value={editDraft}
          onChange={setEditDraft}
          onSubmit={() => submitEdit(post, isThread)}
          onCancel={cancelEdit}
          submitLabel={t.editSave}
          placeholder={t.editPlaceholder}
          disableSubmit={isThread && editTitleDraft.trim() === ''}
        />
      </>
    );
  }

  /** Toggle « chevron + N réponses » : replie/deplie le fil (sujets & commentaires). */
  function renderRepliesToggle(open: boolean, count: number, onToggle: () => void) {
    return (
      <button
        type="button"
        role="replies-toggle"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        aria-expanded={open}
        aria-label={open ? t.collapseReplies : t.expandReplies}
      >
        <Chevron open={open} />
        <span>
          {count} {count > 1 ? t.replyMany : t.replyOne}
        </span>
      </button>
    );
  }

  /** Editeur Markdown de nouvelle reponse, sous le post auquel on repond. */
  function renderReplyComposer(post: ForumPost) {
    return (
      <MarkdownEditor
        value={replyDraft}
        onChange={setReplyDraft}
        onSubmit={() => submitReply(post)}
        onCancel={cancelReply}
        submitLabel={t.reply}
        placeholder={t.replyPlaceholder}
      />
    );
  }

  /** Actions reservees a l'auteur (modifier / supprimer), sinon rien. */
  function renderOwnerActions(post: ForumPost) {
    if (!isOwn(post)) return null;
    return (
      <>
        <button type="button" role="edit" aria-label={t.edit} onClick={() => startEdit(post)}>
          <Pencil width={14} height={14} />
        </button>
        <button
          type="button"
          role="delete"
          aria-label={t.delete}
          onClick={() => setConfirmDeleteId(post.id)}
        >
          <TrashCan width={14} height={14} />
        </button>
      </>
    );
  }

  /**
   * Corps d'une reponse (byline + texte/editeur + actions).
   * `replyToggle` : controle « chevron + N réponses » pose sur la ligne d'actions
   * (replie/deplie la branche), present uniquement quand le post a des reponses.
   */
  function renderCommentInner(post: ForumPost, replyToggle?: React.ReactNode) {
    const editing = editingId === post.id;
    return (
      <div role="comment-body">
        {renderByline(post)}
        {editing ? (
          // Une réponse n'a pas de titre → isThread=false.
          renderEditor(post, false)
        ) : (
          // Une réponse prend aussi en charge le Markdown.
          <Markdown source={post.content} />
        )}
        {!editing && (
          <div role="comment-footer">
            {renderVoteControl(post, true)}
            <div role="post-actions">
              <button
                type="button"
                role="answer"
                aria-label={t.reply}
                onClick={() => startReply(post)}
              >
                <Reply width={14} height={14} />
              </button>
              {renderOwnerActions(post)}
            </div>
            {replyToggle}
          </div>
        )}
      </div>
    );
  }

  /**
   * Corps d'un fil deplie : enfants immediats deja charges, ou etat de chargement
   * paresseux (spinner), ou erreur de chargement (avec « Réessayer »). On n'affiche
   * jamais que le niveau suivant : chaque enfant reste replie. `flat` retire la
   * derive d'indentation (au plateau de profondeur).
   */
  function renderRepliesBody(post: ForumPost, childDepth: number, flat: boolean): React.ReactNode {
    if (replyErrors.has(post.id)) {
      return (
        <div role="replies-error">
          <span>{t.repliesError}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void loadReplies(post.id);
            }}
          >
            {t.retry}
          </button>
        </div>
      );
    }
    // `replies` non charge (undefined) = chargement paresseux en cours.
    if (post.replies === undefined) {
      return (
        <div role="replies-loading">
          <Spinner size={18} />
          <span>{t.repliesLoading}</span>
        </div>
      );
    }
    return (
      <ul role="replies" data-flat={flat || undefined}>
        {post.replies.map((child) => renderComment(child, childDepth))}
      </ul>
    );
  }

  /**
   * Reponse (commentaire) d'un fil. Deplier n'affiche QUE les enfants immediats
   * (pas tout le sous-arbre) et charge la branche paresseusement au besoin.
   * `depth` = profondeur d'imbrication (1 = reponse directe au sujet). L'indentation
   * croit jusqu'a INDENT_PLATEAU_DEPTH puis se stabilise (les niveaux profonds
   * s'alignent au lieu de deriver), de sorte que rien n'est masque et que la colonne
   * de texte ne se reduit jamais a neant. Toute branche se replie via [–]/[+].
   */
  function renderComment(post: ForumPost, depth: number): React.ReactElement {
    const isOpen = expanded.has(post.id);
    // Compteur d'enfants immediats (connu meme branche non depliee, via replyCount).
    const count = replyCountOf(post);
    const hasReplies = count > 0;
    // Au-dela du plateau, on cesse d'indenter (les enfants ne derivent plus).
    const indentChildren = depth < INDENT_PLATEAU_DEPTH;
    // Controle « chevron + N réponses » sur la ligne d'actions : deplie/replie.
    const replyToggle = hasReplies
      ? renderRepliesToggle(isOpen, count, () => toggleReplies(post))
      : null;

    return (
      <li
        key={post.id}
        role="comment"
        data-actions={activeActionsId === post.id ? 'open' : undefined}
        onClick={(event) => {
          event.stopPropagation();
          toggleActions(post.id);
        }}
      >
        {renderCommentInner(post, replyToggle)}
        {replyingTo === post.id && renderReplyComposer(post)}
        {isOpen &&
          hasReplies &&
          (indentChildren ? (
            // Sous le plateau : indentation + filet vertical cliquable (replie la branche).
            <div role="replies-wrap">
              <button
                type="button"
                role="collapse-rail"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleReplies(post);
                }}
                aria-label={t.collapseThread}
                tabIndex={-1}
              />
              {renderRepliesBody(post, depth + 1, false)}
            </div>
          ) : (
            // Au plateau : les reponses profondes s'alignent (plus de derive a droite).
            renderRepliesBody(post, depth + 1, true)
          ))}
      </li>
    );
  }

  /** Carte d'un sujet racine (post + barre de votes + fil repliable). */
  function renderThreadCard(post: ForumPost): React.ReactElement {
    const replyCount = replyCountOf(post);
    const isOpen = expanded.has(post.id);
    const editing = editingId === post.id;
    return (
      <li
        key={post.id}
        data-actions={activeActionsId === post.id ? 'open' : undefined}
        onClick={() => toggleActions(post.id)}
      >
        {renderVoteControl(post)}
        <div role="thread-main">
          {renderByline(post)}
          {post.title && <h2 role="thread-title">{post.title}</h2>}
          {editing ? (
            // Sujet racine → titre editable (isThread=true).
            renderEditor(post, true)
          ) : (
            // Un post parent (sujet) prend en charge le Markdown.
            <Markdown source={post.content} />
          )}
          {!editing && (
            <div role="thread-footer">
              {/* Mobile uniquement : le vote passe sous le post (le rail vertical
                  de gauche est masque), facon reponse. */}
              <div role="mobile-vote">{renderVoteControl(post, true)}</div>
              <div role="post-actions">
                <button
                  type="button"
                  role="answer"
                  aria-label="Répondre"
                  onClick={() => startReply(post)}
                >
                  <Reply width={15} height={15} />
                </button>
                {renderOwnerActions(post)}
              </div>
              {replyCount > 0 ? (
                renderRepliesToggle(isOpen, replyCount, () => toggleReplies(post))
              ) : (
                <span role="no-replies">{t.noReplies}</span>
              )}
            </div>
          )}
          {replyingTo === post.id && renderReplyComposer(post)}
          {isOpen && replyCount > 0 && renderRepliesBody(post, 1, false)}
        </div>
      </li>
    );
  }

  return (
    <div className={styles['forum-view']}>
      <header>
        <p>
          <span>
            <ChannelTypeIcon type={channel.type} />
          </span>
          {channel.name}
        </p>
        <span />
        {courseLabel && <p>{courseLabel}</p>}
      </header>

      {/* La barre d'actions (tri + nouveau sujet) : cachee pendant le chargement. */}
      {!loading && !loadError && (
        <div role="toolbar">
          <div role="group" aria-label={t.sortGroup}>
            <button
              type="button"
              role={sort === 'top' ? 'active-sort' : undefined}
              onClick={() => setSort('top')}
              aria-pressed={sort === 'top'}
            >
              {t.sortTop}
            </button>
            <button
              type="button"
              role={sort === 'recent' ? 'active-sort' : undefined}
              onClick={() => setSort('recent')}
              aria-pressed={sort === 'recent'}
            >
              {t.sortRecent}
            </button>
          </div>
          <button
            type="button"
            role={`new-post${composing ? '-composing' : ''}`}
            onClick={startCompose}
          >
            +<span>{t.newThread}</span>
          </button>
        </div>
      )}

      <div role="body" ref={bodyRef} onScroll={handleBodyScroll}>
        {/* Formulaire « Nouveau sujet » : inline en tete de la liste (pas une autre page). */}
        {composing && (
          <div role="new-thread">
            <h2 role="new-thread-heading">{t.newThreadHeading}</h2>
            <input
              type="text"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder={t.newThreadTitle}
              aria-label={t.newThreadTitle}
              maxLength={128}
              autoFocus
            />
            <MarkdownEditor
              value={newContent}
              onChange={setNewContent}
              onSubmit={publishNewThread}
              onCancel={cancelCompose}
              submitLabel={t.publish}
              disableSubmit={newTitle.trim() === ''}
              autoFocus={false}
              submitting={publishing}
              placeholder={t.newThreadPlaceholder}
            />
          </div>
        )}
        {loading ? (
          <div role="status">
            <Spinner size={24} />
            <p>{t.loading}</p>
          </div>
        ) : loadError ? (
          <div role="status">
            <p>{loadError}</p>
            <button type="button" onClick={handleReload}>
              {t.retry}
            </button>
          </div>
        ) : visibleThreads.length === 0 ? (
          // Pendant la redaction, on n'affiche pas le message « vide » sous le formulaire.
          composing ? null : (
            <p>{t.empty}</p>
          )
        ) : (
          <>
            <ul>{visibleThreads.map(renderThreadCard)}</ul>
            {loadingMore && (
              <div role="status" aria-live="polite">
                <Spinner size={20} />
              </div>
            )}
          </>
        )}
      </div>

      {confirmDeleteId !== null && (
        <DeleteConfirmationPopup
          title={t.deleteTitle}
          content={t.deleteContent}
          onDeleteConfirmation={() => {
            deletePost(confirmDeleteId);
            setConfirmDeleteId(null);
          }}
          onClose={() => setConfirmDeleteId(null)}
        />
      )}

      {error && <ErrorPopup content={error} onClose={clearError} />}
    </div>
  );
};

/** Chevron de vote (trait), oriente vers le haut (upvote) ou le bas (downvote). */
function Arrow({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={direction === 'up' ? 'M4 10 8 6 12 10' : 'M4 6 8 10 12 6'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Chevron du toggle de reponses : pointe vers le bas (ouvert) ou la droite (replie). */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{
        transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 0.15s ease',
      }}
    >
      <path
        d="M4 6L8 10L12 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default ForumView;
