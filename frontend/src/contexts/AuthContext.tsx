import React, { useState, useEffect, type ReactNode } from 'react';
import { type User } from '../types/api';
import apiClient from '../api/client';
import { AuthContext, type AuthContextType } from './AuthContextValue';

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('authToken');
      
      if (token) {
        try {
          const response = await apiClient.getCurrentUser();
          setUser(response.user);
        } catch {
          localStorage.removeItem('authToken');
          localStorage.removeItem('userEmail');
        }
      }
      setIsLoading(false);
    };

    checkAuth();
  }, []);

  const handleAuthResponse = (response: { user: User; token: string }, email: string) => {
    setUser(response.user);
    localStorage.setItem('authToken', response.token);
    localStorage.setItem('userEmail', email);
  };

  const login = async (email: string, password: string) => {
    const response = await apiClient.login(email, password);
    handleAuthResponse(response, email);
  };

  const register = async (email: string, password: string) => {
    const response = await apiClient.register(email, password);
    handleAuthResponse(response, email);
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem('authToken');
    localStorage.removeItem('userEmail');
  };

  const value: AuthContextType = {
    user,
    login,
    register,
    logout,
    isLoading,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
