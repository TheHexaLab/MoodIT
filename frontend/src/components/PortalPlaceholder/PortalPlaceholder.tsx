import React from 'react';
import styles from './PortalPlaceholder.module.css';

/** Écran d'attente d'une page du portail qui n'est pas encore implémentée. */
export default function PortalPlaceholder({ title }: { title: string }): React.ReactElement {
  return (
    <section className={styles.page} aria-label="Contenu principal">
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.subtitle}>Cette page n'est pas encore disponible.</p>
    </section>
  );
}
