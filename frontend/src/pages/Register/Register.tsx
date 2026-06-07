import styles from './Register.module.css';
import { useTheme } from '../../helpers/theme';
import { useState } from 'react';

export default function Register() {
  const { theme, toggleTheme } = useTheme();
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  function passwordStrength(pw: string): 0 | 1 | 2 | 3 {
    if (pw.length === 0) return 0;
    if (pw.length < 8) return 1; // rouge — moins de 8 chars
    const hasNumber = /[0-9]/.test(pw);
    const hasSpecial = /[^A-Za-z0-9]/.test(pw);
    if (hasNumber && hasSpecial) return 3; // vert — 8+ chars + chiffre + spécial
    if (hasNumber || hasSpecial) return 2; // jaune 2 — 8+ chars + chiffre OU spécial
    return 1; // jaune 1 — 8+ chars seulement
  }

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
          <div className={styles.field}>
            <label className={styles.label}>Nom d'utilisateur</label>
            <div className={styles.inputWrap}>
              <input
                type="text"
                value={username}
                placeholder="ex : RKarine"
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Prénom</label>
            <div className={styles.inputWrap}>
              <input
                type="text"
                value={firstName}
                placeholder="ex: Karine"
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Nom</label>
            <div className={styles.inputWrap}>
              <input
                type="text"
                value={name}
                placeholder="ex: Roussel"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Adresse email</label>
            <div className={styles.inputWrap}>
              <input
                type="email"
                value={email}
                placeholder="ex: Karine_Roussel@usherbrooke.ca"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Mot de passe</label>
            <div className={styles.inputWrap}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                placeholder="Choississez un mot de passe"
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className={styles.eye}
                onClick={() => setShowPassword((s) => !s)}
              >
                {showPassword ? (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            {password && (
              <div className={styles.strength} data-level={passwordStrength(password)}>
                <span />
                <span />
                <span />
              </div>
            )}
          </div>

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
