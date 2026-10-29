import React, { useCallback, useEffect, useState } from 'react';
import styles from './AnnouncementView.module.css';
import { ChannelTypeIcon } from '../../CourseChannelList/ChannelTypeIcon';
import { type CourseChannel } from '../../CourseChannelList/CourseChannelList';
import { type Course } from '../../CourseMenu/CourseMenu';
import { getCourseDisplayLabel } from '../../CourseMenu/courseLabel';
import { DeleteConfirmationPopup } from '../../DeleteConfirmationPopup/DeleteConfirmationPopup';
import { ErrorPopup } from '../../ErrorPopup/ErrorPopup';
import { Spinner } from '../../Spinner/Spinner';
import { TrashCan } from '../../../assets/TrashCan';
import { Pencil } from '../../../assets/Pencil';
import { Plus } from '../../../assets/Plus';
import { type ForumPost, type User } from '../../../types/domain';
import { type AnnouncementDraft } from '../../../pages/Dashboard/dashboardApi';
import { type MaybePromise } from '../ChannelView/useChannelMessages';
import { type ForumSocket } from '../ForumView/useForumThreads';
import { Markdown } from '../ForumView/Markdown';
import { AnnouncementFormPopup } from './AnnouncementFormPopup';
import { announcementHex } from './announcementColors';
import { defaultAnnouncementLabels, type AnnouncementLabels } from './labels';

export type FetchAnnouncementsHandler = (
  forumId: number,
  includeExpired: boolean
) => MaybePromise<ForumPost[]>;
export type CreateAnnouncementHandler = (
  forumId: number,
  draft: AnnouncementDraft
) => MaybePromise<ForumPost>;
export type UpdateAnnouncementHandler = (
  forumId: number,
  postId: number,
  draft: AnnouncementDraft
) => MaybePromise<unknown>;
export type DeleteAnnouncementHandler = (forumId: number, postId: number) => MaybePromise<unknown>;

interface AnnouncementViewProps {
  course: Course;
  channel: CourseChannel;
  /**
   * Personnel du cours : publie, modifie et supprime toute annonce, et voit les expirées.
   * Gating COSMÉTIQUE : le permission-service tranche.
   */
  canPost?: boolean;
  onFetchAnnouncements?: FetchAnnouncementsHandler;
  onCreateAnnouncement?: CreateAnnouncementHandler;
  onUpdateAnnouncement?: UpdateAnnouncementHandler;
  onDeleteAnnouncement?: DeleteAnnouncementHandler;
  /** Socket du forum : annonces publiées / supprimées par d'autres, en direct. */
  socket?: ForumSocket;
  labels?: Partial<AnnouncementLabels>;
}

function isExpired(post: ForumPost, now: number): boolean {
  return post.expiresAt != null && Date.parse(post.expiresAt) <= now;
}

const shortDate = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' });

function authorName(author: User): string {
  const full = `${author.firstName ?? ''} ${author.lastName ?? ''}`.trim();
  return full || author.username || '';
}

/** Canal d'annonces d'un cours : cartes teintées, de la plus récente à la plus ancienne. */
const AnnouncementView: React.FC<AnnouncementViewProps> = ({
  course,
  channel,
  canPost = false,
  onFetchAnnouncements,
  onCreateAnnouncement,
  onUpdateAnnouncement,
  onDeleteAnnouncement,
  socket,
  labels,
}) => {
  const t = { ...defaultAnnouncementLabels, ...labels };
  const forumId = channel.id;

  const [announcements, setAnnouncements] = useState<ForumPost[]>([]);
  const [loading, setLoading] = useState(Boolean(onFetchAnnouncements));
  const [loadError, setLoadError] = useState(false);
  /** Incrémenté par « Réessayer » : relance le chargement. */
  const [reloadKey, setReloadKey] = useState(0);
  /** Instant de référence de l'expiration (figé à l'ouverture du canal). */
  const [now] = useState(() => Date.now());
  const [formOpen, setFormOpen] = useState(false);
  /** Annonce en cours de modification (popup pré-rempli), ou null. */
  const [editing, setEditing] = useState<ForumPost | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Ajoute une annonce en tête (la plus récente), sans doublon (écho WS de sa propre annonce). */
  const prepend = useCallback((post: ForumPost) => {
    setAnnouncements((prev) => (prev.some((a) => a.id === post.id) ? prev : [post, ...prev]));
  }, []);

  const patch = useCallback((postId: number, changes: Partial<ForumPost>) => {
    setAnnouncements((prev) => prev.map((a) => (a.id === postId ? { ...a, ...changes } : a)));
  }, []);

  // Chargement (le personnel reçoit aussi les annonces expirées).
  useEffect(() => {
    if (!onFetchAnnouncements) return;
    let cancelled = false;
    Promise.resolve(onFetchAnnouncements(forumId, canPost))
      .then((list) => {
        if (!cancelled) setAnnouncements(list);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onFetchAnnouncements, forumId, canPost, reloadKey]);

  function retry() {
    setLoading(true);
    setLoadError(false);
    setReloadKey((k) => k + 1);
  }

  // Temps réel : annonces publiées / modifiées / supprimées par d'autres membres du personnel.
  useEffect(() => {
    if (!socket) return;
    return socket.subscribe(forumId, {
      onPost: (post, parentId) => {
        if (parentId == null) prepend(post);
      },
      onEdit: (postId, content, title, announcement) =>
        patch(postId, { content, ...(title ? { title } : {}), ...announcement }),
      onDelete: (postId) => setAnnouncements((prev) => prev.filter((a) => a.id !== postId)),
      onVote: () => {},
    });
  }, [socket, forumId, prepend, patch]);

  async function createAnnouncement(draft: AnnouncementDraft) {
    if (!onCreateAnnouncement) return;
    prepend(await onCreateAnnouncement(forumId, draft));
  }

  async function updateAnnouncement(postId: number, draft: AnnouncementDraft) {
    await onUpdateAnnouncement?.(forumId, postId, draft);
    patch(postId, draft);
  }

  async function deleteAnnouncement(postId: number) {
    try {
      await onDeleteAnnouncement?.(forumId, postId);
      setAnnouncements((prev) => prev.filter((a) => a.id !== postId));
    } catch {
      setError(t.deleteError);
    }
  }

  // Un étudiant ne voit pas une annonce expirée (ex. reçue en direct, ou mise en cache).
  const visible = canPost ? announcements : announcements.filter((a) => !isExpired(a, now));

  function renderCard(post: ForumPost) {
    const expired = isExpired(post, now);
    return (
      <li
        key={post.id}
        className={`${styles.card}${expired ? ` ${styles.expired}` : ''}`}
        style={{ '--ann-color': announcementHex(post.color) } as React.CSSProperties}
      >
        <div className={styles['card-head']}>
          <h2>{post.title}</h2>
          {canPost && (
            <div className={styles.actions}>
              <button type="button" aria-label={t.edit} title={t.edit} onClick={() => setEditing(post)}>
                <Pencil width={15} height={15} />
              </button>
              <button
                type="button"
                aria-label={t.delete}
                title={t.delete}
                onClick={() => setConfirmDeleteId(post.id)}
              >
                <TrashCan width={15} height={15} />
              </button>
            </div>
          )}
        </div>
        {post.content.trim() && <Markdown source={post.content} />}
        <p className={styles.meta}>
          <span>{authorName(post.author)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={post.createdAt}>{shortDate.format(new Date(post.createdAt))}</time>
          <span aria-hidden="true">·</span>
          {expired ? (
            <span className={styles.badge}>{t.expired}</span>
          ) : post.expiresAt ? (
            <span>
              {t.expires} {shortDate.format(new Date(post.expiresAt))}
            </span>
          ) : (
            <span>{t.noExpiry}</span>
          )}
        </p>
      </li>
    );
  }

  return (
    <div className={styles['announcement-view']}>
      <header>
        <p>
          <span>
            <ChannelTypeIcon type={channel.type} />
          </span>
          <span>{channel.name}</span>
        </p>
        <span />
        <p>{getCourseDisplayLabel(course)}</p>
        {canPost && (
          <button type="button" className={styles['new-button']} onClick={() => setFormOpen(true)}>
            <Plus width={14} height={14} />
            <span>{t.newAnnouncement}</span>
          </button>
        )}
      </header>

      <div className={styles.body}>
        {loading ? (
          <div className={styles.state} role="status">
            <Spinner />
            <p>{t.loading}</p>
          </div>
        ) : loadError ? (
          <div className={styles.state}>
            <p>{t.loadError}</p>
            <button type="button" onClick={retry}>
              {t.retry}
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.state}>
            <h2>{t.emptyTitle}</h2>
            <p>{canPost ? t.emptyStaff : t.emptyStudent}</p>
          </div>
        ) : (
          <ul className={styles.list}>{visible.map(renderCard)}</ul>
        )}
      </div>

      {formOpen && (
        <AnnouncementFormPopup
          onClose={() => setFormOpen(false)}
          onSubmit={createAnnouncement}
          labels={labels}
        />
      )}
      {editing && (
        <AnnouncementFormPopup
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={(draft) => updateAnnouncement(editing.id, draft)}
          labels={labels}
        />
      )}
      {confirmDeleteId != null && (
        <DeleteConfirmationPopup
          title={t.deleteTitle}
          content={t.deleteContent}
          onDeleteConfirmation={() => {
            void deleteAnnouncement(confirmDeleteId);
            setConfirmDeleteId(null);
          }}
          onClose={() => setConfirmDeleteId(null)}
        />
      )}
      {error && <ErrorPopup content={error} onClose={() => setError(null)} />}
    </div>
  );
};

export default AnnouncementView;
