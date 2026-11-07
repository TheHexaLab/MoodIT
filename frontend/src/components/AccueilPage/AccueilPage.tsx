import React, { useState } from 'react';
import styles from './AccueilPage.module.css';

const FILTERS = ['Tout', 'Annonces', 'Courriels', 'Devoirs'] as const;
type Filter = (typeof FILTERS)[number];

const EMPTY_FEED: Record<Filter, string> = {
  Tout: 'Rien de nouveau pour le moment.',
  Annonces: 'Aucune annonce pour le moment.',
  Courriels: 'Aucun courriel pour le moment.',
  Devoirs: 'Aucun devoir pour le moment.',
};

interface AccueilPageProps {
  firstName?: string;
  /** Date affichée sous le titre (par défaut, aujourd'hui). */
  now?: Date;
}

/** Date du jour avec une majuscule initiale : « Vendredi 30 octobre ». */
function formatToday(now: Date): string {
  const label = new Intl.DateTimeFormat('fr-CA', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Page d'accueil du portail. Pour l'instant, la mise en page seule : le fil et les cartes
 * attendent leurs sources de données (voir #204).
 */
export default function AccueilPage({
  firstName,
  now = new Date(),
}: AccueilPageProps): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('Tout');
  const name = firstName?.trim();

  return (
    <section className={styles.page} aria-label="Contenu principal">
      <div className={styles.main}>
        <div>
          <h1 className={styles.title}>{name ? `Bonjour ${name}` : 'Bonjour'}</h1>
          <p className={styles.subtitle}>{formatToday(now)}</p>
        </div>

        <div className={styles.filters} role="group" aria-label="Filtrer le fil">
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles.filter} ${filter === option ? styles.filterActive : ''}`}
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>

        <div className={styles.feed}>
          <p className={styles.empty}>{EMPTY_FEED[filter]}</p>
        </div>
      </div>

      <aside className={styles.side} aria-label="Résumé">
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Aujourd'hui</h2>
          <p className={styles.cardEmpty}>Votre horaire s'affichera ici.</p>
        </div>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Solde à payer</h2>
          <p className={styles.cardEmpty}>Vos factures s'afficheront ici.</p>
        </div>
      </aside>
    </section>
  );
}
