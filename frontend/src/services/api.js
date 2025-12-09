import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

class ApiService {
  constructor() {
    this.token = localStorage.getItem('authToken');
    this.axios = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { 'Authorization': `Bearer ${this.token}` })
      }
    });

    // Add request interceptor to handle auth
    this.axios.interceptors.request.use((config) => {
      const token = localStorage.getItem('authToken');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    // Add response interceptor to handle auth errors
    this.axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          localStorage.removeItem('authToken');
          window.location.reload();
        }
        return Promise.reject(error);
      }
    );
  }

  async login(username, password) {
    try {
      const response = await this.axios.post('/login', { username, password });
      if (response.data.success) {
        localStorage.setItem('authToken', response.data.token);
        this.token = response.data.token;
        return { success: true, token: response.data.token };
      }
      return { success: false, message: response.data.message };
    } catch (error) {
      return { success: false, message: error.response?.data?.message || 'Login failed' };
    }
  }

  async getDashboardData() {
    try {
      const response = await this.axios.get('/dashboard');
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to fetch dashboard data');
    }
  }

  // Alias for consistency
  async getDashboard() {
    return this.getDashboardData();
  }

  async getTraderDetails(traderId) {
    try {
      const response = await this.axios.get(`/trader/${traderId}`);
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to fetch trader details');
    }
  }

  async createTrader(symbol, takeProfit = 20, testingMode = true) {
    try {
      const response = await this.axios.post('/trader', {
        symbol,
        takeProfit,
        testingMode
      });
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to create trader');
    }
  }

  async deleteTrader(traderId) {
    try {
      const response = await this.axios.delete(`/trader/${traderId}`);
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to delete trader');
    }
  }

  async toggleTradingMode(testingMode) {
    try {
      const response = await this.axios.put('/trading-mode', { testingMode });
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to toggle trading mode');
    }
  }

  async scanOpportunities() {
    try {
      const response = await this.axios.post('/scan-opportunities');
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to scan opportunities');
    }
  }

  isAuthenticated() {
    return !!localStorage.getItem('authToken');
  }

  logout() {
    localStorage.removeItem('authToken');
    this.token = null;
  }
}

export default new ApiService();