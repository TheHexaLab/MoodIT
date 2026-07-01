import styles from './LoadingPage.module.css';
import { Spinner } from '../Spinner/Spinner';

// Page de chargement plein écran, neutre vis-à-vis du thème : elle s'appuie sur les
// variables CSS (--bg-main, --border, --brand-teal…) qui basculent avec data-theme,
// donc elle s'affiche correctement en clair comme en sombre sans logique JS.
export default function LoadingPage() {
  return (
    <div className={styles.page} role="status" aria-live="polite" aria-busy="true">
      <Spinner size={44} />
      <span className={styles.srOnly}>Chargement…</span>
    </div>
  );
}
