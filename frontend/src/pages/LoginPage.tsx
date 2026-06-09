//création de la page de login
//date: 7 juin 2026
//Philip Pigeon

import { useState } from 'react';
import './LoginPage.css';
import { EyeIcon } from '../assets/eye.tsx';
import { Lightanddark } from '../assets/light-dark-btn.tsx';

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);

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

          <form className="form">
            <div className="field">
              <label className="label">Adresse e-mail</label>
              <input className="input" type="email" placeholder="exemple@gmail.com" />
            </div>
            <div className="field">
              <label className="label">Mot de passe</label>
              <div className="input-wrapper">
                <input
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••••"
                />
                <button
                  type="button"
                  className="eye-btn"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  <EyeIcon visible={showPassword} />
                </button>
              </div>
              <a href="#" className="forgot-link">
                Mot de passe oublié ?
              </a>
            </div>
            <button type="submit" className="btn-primary">
              Se connecter →
            </button>
            <p className="or-divider">ou</p> {/* ← celui-là */}
            <p className="register-row">
              Pas encore de compte ?{' '}
              <a href="#" className="register-link">
                Créer un compte
              </a>
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
