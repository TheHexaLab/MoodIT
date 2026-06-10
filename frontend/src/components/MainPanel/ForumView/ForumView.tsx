import React, { useMemo, useRef, useState } from 'react';
import styles from './ForumView.module.css';
import {
  type ChannelMessageAuthor,
  type CourseChannel,
} from '../../CourseChannelList/CourseChannelList';
import { getPrefixForType } from '../../CourseChannelList/channelTypePrefix';
import { type Course } from '../../CourseMenu/CourseMenu';
import { getCourseDisplayLabel } from '../../CourseMenu/courseLabel';
import { contrastingTextColor } from '../../../helpers/color';
import { Reply } from '../../../assets/Reply';
import { Pencil } from '../../../assets/Pencil';
import { TrashCan } from '../../../assets/TrashCan';
import { DeleteConfirmationPopup } from '../../DeleteConfirmationPopup/DeleteConfirmationPopup';
import { ErrorPopup } from '../../ErrorPopup/ErrorPopup';
import { Markdown } from './Markdown';
import { MarkdownEditor } from './MarkdownEditor';
import { getMockForumThreads, type ForumAuthor, type ForumPost } from './forumThreads';
import {
  useForumThreads,
  type CreatePostHandler,
  type DeletePostHandler,
  type EditPostHandler,
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
  /** Forum selectionne (forum de f_type 'Thread' : post + reponses). */
  channel: CourseChannel;
  /** Utilisateur connecte : auteur des publications et des votes. */
  currentUser: ChannelMessageAuthor;
  /** Chargement des sujets (API-ready, GET). Defaut : mock local. */
  onFetchThreads?: FetchThreadsHandler;
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

/** Nom affiche d'un auteur (first_name + last_name). */
function getAuthorName(author: ForumAuthor): string {
  return `${author.first_name} ${author.last_name}`.trim() || author.username;
}

/** Deux initiales affichees dans l'avatar. */
function getInitials(author: ForumAuthor): string {
  const initials = `${author.first_name[0] ?? ''}${author.last_name[0] ?? ''}`.trim();
  return (initials || author.username[0] || '?').toUpperCase();
}

/** Score d'un post : SUM(value_) de tous ses votes. */
function scoreOf(post: ForumPost): number {
  return post.votes.reduce((sum, vote) => sum + vote.value, 0);
}

/** Vote de l'utilisateur `userId` sur un post (depuis la table Vote). */
function userVoteOf(post: ForumPost, userId: number): VoteValue {
  return post.votes.find((vote) => vote.user_id === userId)?.value ?? 0;
}

/** Nombre total de reponses d'un sujet (toute la profondeur du fil). */
function countReplies(post: ForumPost): number {
  return (post.replies ?? []).reduce((total, child) => total + 1 + countReplies(child), 0);
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
 * Etat 6 — vue d'un forum (f_type 'Thread').
 * Discussion facon Reddit : sujets votables + fils de reponses imbriquees.
 */
const ForumView: React.FC<ForumViewProps> = ({
  course,
  channel,
  currentUser,
  onFetchThreads = getMockForumThreads,
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
    onCreatePost,
    onEditPost,
    onDeletePost,
    onVotePost,
    socket,
  });

  // ─── Etat de la VUE uniquement (tri, repli, edition, reponse, actions). ───
  const [sort, setSort] = useState<SortMode>('top');
  // Fils de reponses ouverts (sujets developpes). Reddit : reponses repliees par defaut.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Branches repliees : posts dont on a masque les reponses (toggle chevron).
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  /** Post en cours d'edition inline (null = aucun) + brouillon courant. */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
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

  function toggleReplies(postId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }

  /** Replie (ou deplie) les reponses d'une branche (toggle [–]/[+]). */
  function toggleCollapse(postId: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
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
    // On s'assure que la nouvelle reponse sera visible (sujet deplie, branche ouverte).
    setExpanded((prev) => new Set(prev).add(post.id));
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(post.id);
      return next;
    });
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
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
  }

  /** Valide la modification inline (optimiste via le hook) ; rouvre l'editeur si echec. */
  async function submitEdit(post: ForumPost) {
    const content = editDraft.trim();
    cancelEdit();
    if (!content || content === post.content) return;
    const ok = await editPost(post.id, content);
    if (!ok) {
      // Échec : on rouvre l'editeur avec la saisie pour pouvoir reessayer.
      setEditingId(post.id);
      setEditDraft(content);
    }
  }

  /** Tap sur un post (mobile) : ouvre/ferme son panneau d'actions flottant. */
  function toggleActions(postId: number) {
    setActiveActionsId((prev) => (prev === postId ? null : postId));
  }

  /** Ouvre le formulaire de nouveau sujet (remplace la liste). */
  function startCompose() {
    if (composing) {
      return
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
      if (Boolean(a.is_pinned) !== Boolean(b.is_pinned)) return a.is_pinned ? -1 : 1;
      if (sort === 'recent') {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
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
    const color = post.author.avatar_color ?? DEFAULT_AVATAR_COLOR;
    return (
      <div role="header">
        <span role="avatar" style={{ background: color, color: contrastingTextColor(color) }}>
          <span>{getInitials(post.author)}</span>
        </span>
        <span role="author">{getAuthorName(post.author)}</span>
        <span role="separator" aria-hidden="true">•</span>
        <span role="time">{formatRelativeTime(post.created_at)}</span>
        {post.is_pinned && <span role="pin-indicator">{t.pinned}</span>}
      </div>
    );
  }

  /** Editeur Markdown inline (modification d'un post). */
  function renderEditor(post: ForumPost) {
    return (
      <MarkdownEditor
        value={editDraft}
        onChange={setEditDraft}
        onSubmit={() => submitEdit(post)}
        onCancel={cancelEdit}
        submitLabel={t.editSave}
        placeholder={t.editPlaceholder}
      />
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
        <span>{count} {count > 1 ? t.replyMany : t.replyOne}</span>
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
        <button
          type="button"
          role="edit"
          aria-label={t.edit}
          onClick={() => startEdit(post)}
        >
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
          renderEditor(post)
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
   * Reponse (commentaire) d'un fil, rendue recursivement — profondeur illimitee.
   * `depth` = profondeur d'imbrication (1 = reponse directe au sujet). L'indentation
   * croit jusqu'a INDENT_PLATEAU_DEPTH puis se stabilise (les niveaux profonds
   * s'alignent au lieu de deriver), de sorte que rien n'est masque et que la colonne
   * de texte ne se reduit jamais a neant. Toute branche se replie via [–]/[+].
   */
  function renderComment(post: ForumPost, depth: number): React.ReactElement {
    const children = post.replies ?? [];
    const hasReplies = children.length > 0;
    const isCollapsed = collapsed.has(post.id);
    // Au-dela du plateau, on cesse d'indenter (les enfants ne derivent plus).
    const indentChildren = depth < INDENT_PLATEAU_DEPTH;
    // Controle « chevron + N réponses » sur la ligne d'actions : replie/deplie.
    const count = countReplies(post);
    const replyToggle = hasReplies
      ? renderRepliesToggle(!isCollapsed, count, () => toggleCollapse(post.id))
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
        {hasReplies &&
          !isCollapsed &&
          (indentChildren ? (
            // Sous le plateau : indentation + filet vertical cliquable (replie la branche).
            <div role="replies-wrap">
              <button
                type="button"
                role="collapse-rail"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleCollapse(post.id);
                }}
                aria-label={t.collapseThread}
                tabIndex={-1}
              />
              <ul role="replies">
                {children.map((child) => renderComment(child, depth + 1))}
              </ul>
            </div>
          ) : (
            // Au plateau : les reponses profondes s'alignent (plus de derive a droite).
            <ul role="replies" data-flat>
              {children.map((child) => renderComment(child, depth + 1))}
            </ul>
          ))}
      </li>
    );
  }

  /** Carte d'un sujet racine (post + barre de votes + fil repliable). */
  function renderThreadCard(post: ForumPost): React.ReactElement {
    const replyCount = countReplies(post);
    const isOpen = expanded.has(post.id);
    const replies = post.replies ?? [];
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
            renderEditor(post)
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
                renderRepliesToggle(isOpen, replyCount, () => toggleReplies(post.id))
              ) : (
                <span role="no-replies">{t.noReplies}</span>
              )}
            </div>
          )}
          {replyingTo === post.id && renderReplyComposer(post)}
          {isOpen && replies.length > 0 && (
            <ul role="replies">
              {replies.map((reply) => renderComment(reply, 1))}
            </ul>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className={styles['forum-view']}>
      <header>
        <p>
          <span>{getPrefixForType(channel.type)}</span>
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
          <button type="button" role={`new-post${composing ? '-composing' : ''}`} onClick={startCompose}>
            +<span>{t.newThread}</span>
          </button>
        </div>
      )}

      <div role="body" ref={bodyRef}>
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
            <span role="spinner" aria-hidden="true" />
            <p>{t.loading}</p>
          </div>
        ) : loadError ? (
          <div role="status">
            <p>{loadError}</p>
            <button type="button" onClick={reload}>
              {t.retry}
            </button>
          </div>
        ) : visibleThreads.length === 0 ? (
          // Pendant la redaction, on n'affiche pas le message « vide » sous le formulaire.
          composing ? null : (
            <p>{t.empty}</p>
          )
        ) : (
          <ul>{visibleThreads.map(renderThreadCard)}</ul>
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
