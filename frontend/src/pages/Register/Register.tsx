import styles from './Register.module.css';
import { useTheme } from '../../helpers/theme';
import { useState } from 'react';
import { register } from '../../helpers/api';
import { Lightanddark } from '../../assets/light-dark-btn';
import { Link, useNavigate } from 'react-router-dom';

export default function Register() {
  const { theme, toggleTheme } = useTheme();
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const navigate = useNavigate();

  function passwordStrength(pw: string): 0 | 1 | 2 | 3 | 4 {
    if (pw.length === 0) return 0;
    if (pw.length < 8) return 1;
    const hasNumber = /[0-9]/.test(pw);
    const hasSpecial = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw);
    if (hasNumber && hasSpecial) return 4;
    if (hasNumber || hasSpecial) return 3;
    return 2;
  }

  async function handleSubmit() {
    setServerError('');

    if (!username || !firstName || !name || !email || !password) {
      setServerError('Veuillez remplir tous les champs');
      return;
    }
    if (!acceptTerms) {
      setServerError("Vous devez accepter les conditions d'utilisation");
      return;
    }
    if (passwordStrength(password) < 2) {
      setServerError('Mot de passe trop faible');
      return;
    }

    setSubmitting(true);
    try {
      await register({
        username,
        firstName,
        lastName: name,
        email,
        password,
      });
      navigate('/verify-code', { state: { email, mode: 'email' } });
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <aside className={styles.brand}>
        <div className={styles.bubble1} />
        <div className={styles.bubble2} />
        <div className={styles.bubble3} />
        <div className={styles.brandInner}>
          <div className={styles.logoWrapper}>
            <img src="/Logo.png" alt="Logo" />
          </div>
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
          <Lightanddark isDark={theme === 'dark'} />
        </button>

        <div className={styles.card}>
          <>
              <header className={styles.cardHeader}>
                <h2>Créer un compte</h2>
                <p>Rejoignez votre espace MoodIT</p>
              </header>

              {serverError && <p className={styles.serverError}>⚠ {serverError}</p>}

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
                <div className={styles.labelRow}>
                  <label className={styles.label}>Mot de passe</label>
                  {password && (
                    <span className={styles.strengthLabel} data-level={passwordStrength(password)}>
                      {passwordStrength(password) === 1 && 'Mot de passe trop court'}
                      {passwordStrength(password) === 2 && 'Mot de passe faible'}
                      {passwordStrength(password) === 3 && 'Mot de passe moyen'}
                      {passwordStrength(password) === 4 && 'Mot de passe fort'}
                    </span>
                  )}
                </div>
                <div className={styles.inputWrap}>
                  <input
                    type="password"
                    value={password}
                    placeholder="Choisissez un mot de passe"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                {password && (
                  <div className={styles.strength} data-level={passwordStrength(password)}>
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>

              <label className={styles.terms}>
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(e.target.checked)}
                />
                <span>
                  J'accepte les{' '}
                  <a
                    href="https://www.youtube.com/watch?v=Aq5WXmQQooo"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    conditions d'utilisation
                  </a>{' '}
                  et la{' '}
                  <a
                    href="https://www.youtube.com/watch?v=Aq5WXmQQooo"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    politique de confidentialité
                  </a>
                </span>
              </label>

              <button
                type="button"
                className={styles.submit}
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? 'Création...' : 'Créer mon compte →'}
              </button>

              <div className={styles.divider}>
                <span>ou</span>
              </div>

              <p className={styles.loginLink}>
                Déjà un compte ? <Link to="/login">Se connecter</Link>
              </p>
          </>
        </div>

        <footer className={styles.pageFooter}>
          © 2026 MoodIT · Confidentialité · Conditions d'utilisation
        </footer>
      </main>
    </div>
  );
}
