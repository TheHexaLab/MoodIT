import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import Register from './pages/Register/Register';
import Dashboard from './pages/Dashboard/Dashboard';
import VerifyCode from './pages/VerifyCode/VerifyCode';
import ProtectedRoute from './components/ProtectedRoute';
import CurrentUserProvider from './context/CurrentUserProvider';
import './pages/LoginPage.css';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/home"
        element={
          <CurrentUserProvider>
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          </CurrentUserProvider>
        }
      />
      <Route path="/verify-code" element={<VerifyCode />} />
      <Route path="/" element={<Navigate to="/home" replace />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
