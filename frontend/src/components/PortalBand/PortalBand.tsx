import React from 'react';
import { Link } from 'react-router-dom';
import styles from './PortalBand.module.css';
import { currentSessionLabel } from './currentSession.ts';

interface PortalBandProps {
  /** Nom de l'établissement de l'utilisateur (absent : « MoodIT »). */
  establishmentName?: string;
}

/** Bandeau du portail : nom de l'établissement (retour à l'Accueil au clic) et session en cours. */
export default function PortalBand({ establishmentName }: PortalBandProps): React.ReactElement {
  const name = establishmentName?.trim() || 'MoodIT';

  return (
    <header className={styles.band}>
      <Link to="/home" className={styles.home} aria-label={`${name}, retour à l'Accueil`}>
        <span className={styles.logo} aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </span>
        <span className={styles.name}>{name}</span>
      </Link>
      <span className={styles.session}>{currentSessionLabel()}</span>
      {/* Recherche à venir : présente pour la maquette, sans action pour l'instant. */}
      <button
        type="button"
        className={styles.search}
        aria-label="Rechercher"
        aria-disabled="true"
        title="Bientôt disponible"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  );
}
