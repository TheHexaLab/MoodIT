import React, { useLayoutEffect, useRef, useState } from 'react';
import styles from './ChannelView.module.css';
import {
  type ChannelMessage,
  type ChannelMessageAuthor,
  type CourseChannel,
} from '../../CourseChannelList/CourseChannelList';
import { getPrefixForType } from '../../CourseChannelList/channelTypePrefix';
import { type Course } from '../../CourseMenu/CourseMenu';
import { ErrorPopup } from '../../ErrorPopup/ErrorPopup';
import { DeleteConfirmationPopup } from '../../DeleteConfirmationPopup/DeleteConfirmationPopup';
import { Pencil } from '../../../assets/Pencil';
import { Reply } from '../../../assets/Reply';
import { Send } from '../../../assets/Send';
import { TrashCan } from '../../../assets/TrashCan';
import { contrastingTextColor } from '../../../helpers/color';
import {
  useChannelMessages,
  type ChannelSocket,
  type DeleteMessageHandler,
  type EditMessageHandler,
  type MaybePromise,
  type SendMessageHandler,
} from './useChannelMessages';

// Re-export : MainPanel et Dashboard importent ces types depuis ChannelView.
export type {
  SendMessageHandler,
  EditMessageHandler,
  DeleteMessageHandler,
  ChannelSocket,
};

interface ChannelViewProps {
  /** Cours appartenant au canal (contexte d'en-tête). */
  course: Course;
  /** Canal sélectionné (forum de f_type 'Discussion', rendu comme un canal/chat). */
  channel: CourseChannel;
  /** Utilisateur connecte : auteur des messages envoyés, et seul à pouvoir
   *  modifier/supprimer ses propres messages. */
  currentUser: ChannelMessageAuthor;
  /** Chargement de l'historique du canal (API-ready, GET). Voir useChannelMessages. */
  onFetchMessages?: (channelId: number) => MaybePromise<ChannelMessage[]>;
  /**
   * Émise à l'envoi d'un message. Async : le message s'affiche de manière
   * optimiste ; si l'appel rejette, il est retiré et le brouillon restaure.
   */
  onSendMessage?: SendMessageHandler;
  /** Émise à la modification d'un de ses messages (optimiste + rollback). */
  onEditMessage?: EditMessageHandler;
  /** Émise à la suppression d'un de ses messages (optimiste + rollback). */
  onDeleteMessage?: DeleteMessageHandler;
  /** Socket temps reel (optionnel) : reception des messages des autres users. */
  socket?: ChannelSocket;
}

/** Couleur d'avatar par défaut (= Program/User color par défaut en BD). */
const DEFAULT_AVATAR_COLOR = '#0a5cc0';

/** Heure courte (HH : MM) à partir d'un timestamp ISO. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-CA', { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Cle de jour (local) pour détecter un changement de date entre deux messages. */
function getDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Libelle du séparateur de date (ex. "5 juin 2026"). */
function formatDaySeparator(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-CA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** Nom affiche d'un auteur (first_name + last_name). */
function getAuthorName(author: ChannelMessageAuthor): string {
  return `${author.first_name} ${author.last_name}`.trim() || author.username;
}

/** Deux initiales affichées dans l'avatar (first_name + last_name). */
function getInitials(author: ChannelMessageAuthor): string {
  const initials = `${author.first_name[0] ?? ''}${author.last_name[0] ?? ''}`.trim();
  return (initials || author.username[0] || '?').toUpperCase();
}

/** Apercu court (une ligne) du contenu d'un message, pour la reference de réponse. */
function getSnippet(content: string, max = 64): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * État 5 — vue d'un canal de discussion (f_type 'Discussion').
 * Échange libre facon chat : liste des messages + zone de saisie.
 */
const ChannelView: React.FC<ChannelViewProps> = ({
  course,
  channel,
  currentUser,
  onFetchMessages,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  socket,
}: ChannelViewProps) => {
  // ─── État de la VUE (composer, édition, réponse, actions). ───
  /** Contenu courant de la zone de saisie. */
  const [draft, setDraft] = useState('');
  /** Id du message en cours d'édition (null = aucun), et brouillon d'édition. */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  /** Id du message dont on demande confirmation de suppression (null = aucun). */
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  /** Message auquel on est en train de répondre (null = nouveau message racine). */
  const [replyingTo, setReplyingTo] = useState<ChannelMessage | null>(null);
  /** Message dont les actions sont ouvertes au tap (tactile, sans survol). */
  const [activeActionsId, setActiveActionsId] = useState<number | null>(null);
  /** Elements DOM des messages, par id : permet de remonter au message parent. */
  const messageRefs = useRef(new Map<number, HTMLLIElement>());
  /** Conteneur scrollable de la liste (pour l'auto-scroll vers le bas). */
  const listRef = useRef<HTMLUListElement>(null);
  /** L'utilisateur est-il (proche du) bas de la liste ? Pilote l'auto-scroll. */
  const atBottomRef = useRef(true);

  // ─── Source de vérité des messages : optimiste + API + WebSocket-ready. ───
  // (Les événements WebSocket entrants se branchent sur applyIncoming* du hook.)
  const {
    messages,
    loading,
    loadError,
    reload,
    pending,
    error,
    clearError,
    sendMessage,
    editMessage,
    deleteMessage,
  } = useChannelMessages({
    channelId: channel.id,
    initialMessages: channel.messages ?? [],
    currentUser,
    onFetchMessages,
    onSendMessage,
    onEditMessage,
    onDeleteMessage,
    socket,
  });

  /** Index par id pour résoudre le message parent d'une réponse. */
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const canSend = draft.trim() !== '' && !pending;

  /** Fait defiler jusqu'au message cible (clic sur une reference de réponse). */
  function scrollToMessage(messageId: number) {
    messageRefs.current.get(messageId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** Colle la liste tout en bas. */
  function scrollToBottom() {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }

  /** A chaque scroll : memorise si on est (proche du) bas (seuil 80px). */
  function handleListScroll() {
    const list = listRef.current;
    if (!list) return;
    atBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  // Auto-scroll « stick to bottom » : on descend en bas a l'arrivee de messages
  // SEULEMENT si l'utilisateur y etait deja (sinon on ne l'arrache pas a sa lecture).
  // Au chargement initial, atBottomRef vaut true → on part bien en bas.
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [messages, loading]);

  /** Envoie le message saisi (optimiste via le hook) ; restaure le composer si échec. */
  async function handleSend() {
    const content = draft.trim();
    if (!content || pending) return;
    const parent = replyingTo;
    setDraft('');
    setReplyingTo(null);
    atBottomRef.current = true; // envoyer = on veut voir son propre message en bas
    const ok = await sendMessage(content, parent ? parent.id : null);
    if (!ok) {
      // Échec : on restaure le brouillon et la réponse pour réessayer.
      setDraft(content);
      setReplyingTo(parent);
    }
  }

  /** Démarre une réponse à un message (affiche la barre au-dessus du composer). */
  function startReply(message: ChannelMessage) {
    setReplyingTo(message);
  }

  /** L'utilisateur connecte est-il l'auteur de ce message ? */
  function isOwnMessage(message: ChannelMessage): boolean {
    return message.author.id === currentUser.id;
  }

  function startEdit(message: ChannelMessage) {
    setConfirmDeleteId(null);
    setEditingId(message.id);
    setEditDraft(message.content);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
  }

  /** Valide la modification inline (optimiste via le hook). */
  function submitEdit(messageId: number, currentContent: string) {
    const content = editDraft.trim();
    cancelEdit();
    if (!content || content === currentContent) return;
    editMessage(messageId, content);
  }

  return (
    <>
      <div className={styles['channel-view']}>
        <header>
          <p>
            <span>{getPrefixForType(channel.type)}</span>
            {channel.name}
          </p>
          <span />
          <p>{course.title}</p>
        </header>

        <div>
          {loading ? (
            <div>
              <span className={styles.spinner} aria-hidden="true" />
              <p>Chargement des messages…</p>
            </div>
          ) : loadError ? (
            <div>
              <p>{loadError}</p>
              <button type="button" onClick={reload}>
                Réessayer
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div>
              <p>Aucun message dans ce canal pour l'instant.</p>
            </div>
          ) : (
            <ul ref={listRef} onScroll={handleListScroll}>
              {messages.map((message, index) => {
                const avatarColor = message.author.avatar_color ?? DEFAULT_AVATAR_COLOR;
                const authorName = getAuthorName(message.author);
                const previous = messages[index - 1];
                const showDateSeparator =
                  !previous || getDayKey(previous.created_at) !== getDayKey(message.created_at);
                // Reference au message parent (réponse), facon Discord.
                const isReply = message.post_parent_id != null;
                const parent = isReply
                  ? messagesById.get(message.post_parent_id as number)
                  : undefined;
                return (
                  <React.Fragment key={message.id}>
                    {showDateSeparator && (
                      <li role="separator">
                        <span>{formatDaySeparator(message.created_at)}</span>
                      </li>
                    )}
                    <li
                      role="message"
                      data-actions={activeActionsId === message.id ? 'open' : undefined}
                      onClick={() =>
                        setActiveActionsId((prev) => (prev === message.id ? null : message.id))
                      }
                      ref={(el) => {
                        if (el) messageRefs.current.set(message.id, el);
                        else messageRefs.current.delete(message.id);
                      }}
                    >
                      {isReply && (
                        <button
                          type="button"
                          onClick={() => parent && scrollToMessage(parent.id)}
                          disabled={!parent}
                        >
                          {parent ? (
                            <>
                              <span
                                className={styles.replyRefAvatar}
                                style={{
                                  background: parent.author.avatar_color ?? DEFAULT_AVATAR_COLOR,
                                  color: contrastingTextColor(
                                    parent.author.avatar_color ?? DEFAULT_AVATAR_COLOR
                                  ),
                                }}
                              >
                                {getInitials(parent.author)}
                              </span>
                              <span className={styles.replyRefName}>
                                {getAuthorName(parent.author)}
                              </span>
                              <span className={styles.replyRefText}>
                                {getSnippet(parent.content)}
                              </span>
                            </>
                          ) : (
                            <span className={styles.replyRefText}>Message original supprimé</span>
                          )}
                        </button>
                      )}
                      <span
                        style={{
                          background: avatarColor,
                          color: contrastingTextColor(avatarColor),
                        }}
                      >
                        {getInitials(message.author)}
                      </span>
                      <div role={editingId === message.id ? "editor" : undefined}>
                        <p>
                          <span>{authorName}</span>
                          <span>{formatTime(message.created_at)}</span>
                        </p>
                        {editingId === message.id ? (
                          <div>
                            <input
                              type="text"
                              value={editDraft}
                              onChange={(event) => setEditDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                  event.preventDefault();
                                  submitEdit(message.id, message.content);
                                } else if (event.key === 'Escape') {
                                  event.preventDefault();
                                  cancelEdit();
                                }
                              }}
                              aria-label="Modifier le message"
                              autoFocus
                            />
                            <div>
                              <button type="button" onClick={cancelEdit}>
                                Annuler
                              </button>
                              <button
                                type="button"
                                onClick={() => submitEdit(message.id, message.content)}
                              >
                                Enregistrer
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p>{message.content}</p>
                        )}
                      </div>
                      {editingId !== message.id && (
                        <div role="message-actions">
                          <button
                            type="button"
                            role="reply"
                            aria-label="Répondre au message"
                            onClick={() => startReply(message)}
                          >
                            <Reply />
                          </button>
                          {isOwnMessage(message) && (
                            <>
                              <button
                                type="button"
                                aria-label="Modifier le message"
                                onClick={() => startEdit(message)}
                              >
                                <Pencil />
                              </button>
                              <button
                                type="button"
                                role="delete"
                                aria-label="Supprimer le message"
                                onClick={() => setConfirmDeleteId(message.id)}
                              >
                                <TrashCan />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  </React.Fragment>
                );
              })}
            </ul>
          )}

          <div role={replyingTo ? 'reply' : undefined}>
            <div>
              {replyingTo && (
                <div>
                  <span>
                    Répondre à <strong>{getAuthorName(replyingTo.author)}</strong>
                  </span>
                  <button
                    type="button"
                    aria-label="Annuler la réponse"
                    onClick={() => setReplyingTo(null)}
                  >
                    ✕
                  </button>
                </div>
              )}
              <button type="button" aria-label="Ajouter une pièce jointe">
                +
              </button>
              <input
                type="text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={`Envoyer un message dans #${channel.name}`}
                aria-label={`Envoyer un message dans ${channel.name}`}
              />
              <button
                type="button"
                aria-label="Envoyer le message"
                onClick={handleSend}
                disabled={!canSend}
              >
                <Send width={18} height={18} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmDeleteId !== null && (
        <DeleteConfirmationPopup
          title="Supprimer le message"
          content="Ce message sera définitivement supprimé. Continuer ?"
          onDeleteConfirmation={() => {
            deleteMessage(confirmDeleteId);
            setConfirmDeleteId(null);
          }}
          onClose={() => setConfirmDeleteId(null)}
        />
      )}

      {error && <ErrorPopup content={error} onClose={clearError} />}
    </>
  );
};

export default ChannelView;
