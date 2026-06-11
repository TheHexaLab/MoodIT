//création de la page de login
//date: 7 juin 2026
//Philip Pigeon

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import './LoginPage.css';
import { EyeIcon } from '../assets/eye.tsx';
import { Lightanddark } from '../assets/light-dark-btn.tsx';
import { login } from '../helpers/api';

export default function LoginPage() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [isDark, setIsDark] = useState(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      return true;
    }
    document.documentElement.setAttribute('data-theme', 'light');
    return false;
  });

  const toggleTheme = () => {
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    setIsDark(!isDark);
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Veuillez remplir tous les champs');
      return;
    }

    setSubmitting(true);
    try {
      await login({ email, password });
      navigate('/verify-code', { state: { email, mode: '2fa' } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <aside className="aside">
        <div className="bubble-1" />
        <div className="bubble-2" />
        <div className="bubble-3" />
        <div className="aside-content">
          <div className="logo-wrapper">
            <img src="../../images/Logo.png" alt="Logo" />
          </div>
          <h1 className="app-name">MoodIT</h1>
          <p className="app-tagline">
            Parce que Moodle,
            <br />
            c'est pas assez chaotique.
          </p>
        </div>
      </aside>

      <main className="main">
        <button type="button" className="light-dark-btn" onClick={toggleTheme}>
          <Lightanddark isDark={isDark} />
        </button>
        <div className="form-card">
          <h2 className="form-title">Bon retour 👋</h2>
          <p className="form-subtitle">Connectez-vous à votre espace MoodIT</p>

          <form className="form" onSubmit={handleSubmit}>
            {error && <p className="server-error">⚠ {error}</p>}
            <div className="field">
              <label className="label">Adresse e-mail</label>
              <input
                className="input"
                type="email"
                placeholder="exemple@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label">Mot de passe</label>
              <div className="input-wrapper">
                <input
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="eye-btn"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  <EyeIcon visible={showPassword} />
                </button>
              </div>
              <a href="#" className="forgot-password">
                Mot de passe oublié ?
              </a>
            </div>
            <button type="submit" className="submit-btn" disabled={submitting}>
              {submitting ? 'Connexion...' : 'Se connecter →'}
            </button>
            <p className="or-divider">ou</p>
            <p className="register-row">
              Pas encore de compte ?{' '}
              <Link to="/register" className="register-link">
                Créer un compte
              </Link>
            </p>
          </form>
        </div>

        <footer className="footer">
          © 2026 MoodIT · <a href="#">Confidentialité</a> · <a href="#">Conditions d'utilisation</a>
        </footer>
      </main>
    </div>
  );
}
