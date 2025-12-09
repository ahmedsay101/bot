import React, { useState } from 'react';
import { Lock, User } from 'lucide-react';
import ApiService from '../services/api';

const LoginPage = ({ onLogin }) => {
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await ApiService.login(credentials.username, credentials.password);
      if (result.success) {
        onLogin();
      } else {
        setError(result.message || 'Invalid credentials');
      }
    } catch (err) {
      setError('Connection failed. Please check your server.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-trading-dark flex items-center justify-center">
      <div className="bg-trading-card p-8 rounded-lg border border-trading-border shadow-2xl w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="bg-trading-blue p-3 rounded-full">
              <Lock className="w-8 h-8 text-white" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-trading-text mb-2">Trading Platform</h1>
          <p className="text-trading-text-muted">Sign in to access your dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-trading-text mb-2">
              Username
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-trading-text-muted w-5 h-5" />
              <input
                type="text"
                value={credentials.username}
                onChange={(e) => setCredentials({...credentials, username: e.target.value})}
                className="w-full pl-10 pr-4 py-3 bg-trading-dark border border-trading-border rounded-lg 
                         text-trading-text placeholder-trading-text-muted focus:outline-none 
                         focus:border-trading-blue focus:ring-1 focus:ring-trading-blue"
                placeholder="Enter your username"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-trading-text mb-2">
              Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-trading-text-muted w-5 h-5" />
              <input
                type="password"
                value={credentials.password}
                onChange={(e) => setCredentials({...credentials, password: e.target.value})}
                className="w-full pl-10 pr-4 py-3 bg-trading-dark border border-trading-border rounded-lg 
                         text-trading-text placeholder-trading-text-muted focus:outline-none 
                         focus:border-trading-blue focus:ring-1 focus:ring-trading-blue"
                placeholder="Enter your password"
                required
              />
            </div>
          </div>

          {error && (
            <div className="bg-trading-red/10 border border-trading-red/20 rounded-lg p-3">
              <p className="text-trading-red text-sm">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-trading-blue hover:bg-blue-600 disabled:opacity-50 
                     text-white font-medium py-3 px-4 rounded-lg transition-colors 
                     focus:outline-none focus:ring-2 focus:ring-trading-blue focus:ring-offset-2 
                     focus:ring-offset-trading-card"
          >
            {loading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-xs text-trading-text-muted">
            Secure access to professional trading platform
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;