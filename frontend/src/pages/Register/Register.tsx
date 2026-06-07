import styles from './Register.module.css';
import { useTheme } from '../../helpers/theme';

export default function Register() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className={styles.page}>
      <aside className={styles.brand}>
        <div className={styles.brandInner}>
          <h1 className={styles.brandTitle}>MoodIT</h1>
          <p className={styles.brandTagline}>Parce que Moodle, c'était pas assez chaotique.</p>
        </div>
      </aside>

      <main className={styles.formSide}>
        <button
          type="button"
          className={styles.themeToggle}
          onClick={toggleTheme}
          aria-label="Changer de thème"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>

        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2>Créer un compte</h2>
            <p>Rejoignez votre espace MoodIT</p>
          </header>

          <button type="button" className={styles.submit}>
            Créer mon compte →
          </button>

          <div className={styles.divider}>
            <span>ou</span>
          </div>

          <p className={styles.loginLink}>
            Déjà un compte ? <a href="#">Se connecter</a>
          </p>
        </div>

        <footer className={styles.pageFooter}>
          © 2026 MoodIT · Confidentialité · Conditions d'utilisation
        </footer>
      </main>
    </div>
  );
}
