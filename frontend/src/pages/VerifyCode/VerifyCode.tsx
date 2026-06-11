import { useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import styles from './VerifyCode.module.css';
import { useTheme } from '../../helpers/theme';

type Mode = 'email' | '2fa';

export default function VerifyCode() {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const email: string = location.state?.email || '';
  const mode: Mode = location.state?.mode || 'email';

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const isEmailVerification = mode === 'email';

  async function handleSubmit() {
    setError('');

    if (code.length !== 6) {
      setError('Le code doit contenir 6 chiffres');
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = isEmailVerification ? '/auth/verify-email' : '/auth/verify-2fa';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || 'Code invalide');
        return;
      }

      if (isEmailVerification) {
        setSuccess(true);
      } else {
        // 2FA — stocker le token et rediriger
        localStorage.setItem('moodit_token', data.token);
        navigate('/');
      }
    } catch {
      setError('Erreur de connexion au serveur');
    } finally {
      setSubmitting(false);
    }
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
          {success ? (
            <div className={styles.successBox}>
              <h2>Email vérifié! ✅</h2>
              <p>Votre compte est maintenant actif.</p>
              <Link to="/login" className={styles.submitLink}>
                Se connecter →
              </Link>
            </div>
          ) : (
            <>
              <header className={styles.cardHeader}>
                <h2>{isEmailVerification ? 'Vérifiez votre email' : 'Double authentification'}</h2>
                <p>
                  Un code a été envoyé à <strong>{email}</strong>.
                  Il expire dans 15 minutes.
                </p>
              </header>

              {error && <p className={styles.serverError}>⚠ {error}</p>}

              <div className={styles.field}>
                <label className={styles.label}>Code à 6 chiffres</label>
                <div className={styles.inputWrap}>
                  <input
                    type="text"
                    value={code}
                    maxLength={6}
                    placeholder="123456"
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
              </div>

              <button
                type="button"
                className={styles.submit}
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? 'Vérification...' : 'Vérifier →'}
              </button>

              <p className={styles.backLink}>
                <Link to={isEmailVerification ? '/register' : '/login'}>
                  ← Retour
                </Link>
              </p>
            </>
          )}
        </div>

        <footer className={styles.pageFooter}>
          © 2026 MoodIT · Confidentialité · Conditions d'utilisation
        </footer>
      </main>
    </div>
  );
}