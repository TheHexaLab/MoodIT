import React, { useEffect, useState, type ReactNode } from 'react';
import styles from './WsTestContextMenu.module.css';
import {
  hasActiveChannel,
  hasActiveForum,
  simulateIncomingDelete,
  simulateIncomingEdit,
  simulateIncomingForumDelete,
  simulateIncomingForumEdit,
  simulateIncomingForumPost,
  simulateIncomingForumVote,
  simulateIncomingMessage,
} from './mockSocket';

interface WsTestContextMenuProps {
  /** Element declencheur : un clic droit dessus ouvre le menu de test WS. */
  children: ReactNode;
}

/**
 * Outil de DEV : enveloppe un element et ouvre, au clic droit, un petit menu
 * pour simuler les evenements WebSocket (reception / modification / suppression).
 * `display: contents` sur l'enveloppe → aucun impact sur la mise en page.
 */
export function WsTestContextMenu({ children }: WsTestContextMenuProps): React.ReactElement {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Etat capture a l'ouverture (les fonctions mock ne sont pas reactives).
  const canSimulate = pos !== null && hasActiveChannel();
  const canSimulateForum = pos !== null && hasActiveForum();

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPos(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [pos]);

  function run(action: () => void) {
    action();
    setPos(null);
  }

  return (
    <>
      <span
        style={{ display: 'contents' }}
        onContextMenu={(event) => {
          event.preventDefault();
          setPos({ x: event.clientX, y: event.clientY });
        }}
      >
        {children}
      </span>

      {pos && (
        <div
          className={styles.menu}
          style={{ top: pos.y, left: pos.x }}
          role="menu"
          onContextMenu={(event) => event.preventDefault()}
        >
          <p className={styles.heading}>Test WebSocket</p>

          {canSimulate && (
            <>
              <button type="button" onClick={() => run(simulateIncomingMessage)}>
                Recevoir un message
              </button>
              <button type="button" onClick={() => run(simulateIncomingEdit)}>
                Modifier le dernier
              </button>
              <button type="button" onClick={() => run(simulateIncomingDelete)}>
                Supprimer le dernier
              </button>
            </>
          )}

          {canSimulateForum && (
            <>
              <button type="button" onClick={() => run(simulateIncomingForumPost)}>
                Recevoir un sujet
              </button>
              <button type="button" onClick={() => run(simulateIncomingForumVote)}>
                Voter le dernier (+1)
              </button>
              <button type="button" onClick={() => run(simulateIncomingForumEdit)}>
                Modifier le dernier
              </button>
              <button type="button" onClick={() => run(simulateIncomingForumDelete)}>
                Supprimer le dernier
              </button>
            </>
          )}

          {!canSimulate && !canSimulateForum && (
            <p className={styles.hint}>Ouvre un canal ou un forum d'abord.</p>
          )}
        </div>
      )}
    </>
  );
}
