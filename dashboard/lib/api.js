'use client';
import axios from 'axios';

const TOKEN_KEY = 'bot_jwt';
const isBrowser = typeof window !== 'undefined';

export function getToken() {
  if (!isBrowser) return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (!isBrowser) return;
  if (t) window.localStorage.setItem(TOKEN_KEY, t);
  else window.localStorage.removeItem(TOKEN_KEY);
}
export function clearToken() {
  if (!isBrowser) return;
  window.localStorage.removeItem(TOKEN_KEY);
}

export const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && isBrowser) {
      clearToken();
      if (window.location.pathname !== '/login') window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

export async function login(username, password) {
  const { data } = await api.post('/auth/login', { username, password });
  setToken(data.token);
  return data;
}

export const apiGet = (path, params) => api.get(path, { params }).then((r) => r.data);
export const apiPost = (path, body) => api.post(path, body).then((r) => r.data);
export const apiPut = (path, body) => api.put(path, body).then((r) => r.data);
