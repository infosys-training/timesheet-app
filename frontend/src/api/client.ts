import axios, { type AxiosInstance, type AxiosResponse } from 'axios';

const API_BASE_URL = '';

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.client.interceptors.request.use(
      (config) => {
        const token = localStorage.getItem('authToken');
        if (token) config.headers['Authorization'] = `Bearer ${token}`;
        return config;
      },
      (error) => Promise.reject(error)
    );

    this.client.interceptors.response.use(
      (response: AxiosResponse) => response,
      (error) => {
        if (error.response?.status === 401) {
          localStorage.removeItem('authToken');
          localStorage.removeItem('userEmail');
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    );
  }

  private async get<T = unknown>(url: string, config?: object): Promise<T> {
    return (await this.client.get(url, config)).data;
  }

  private async post<T = unknown>(url: string, data?: object): Promise<T> {
    return (await this.client.post(url, data)).data;
  }

  private async put<T = unknown>(url: string, data?: object): Promise<T> {
    return (await this.client.put(url, data)).data;
  }

  private async del<T = unknown>(url: string): Promise<T> {
    return (await this.client.delete(url)).data;
  }

  // Auth
  login(email: string, password: string) { return this.post('/api/auth/login', { email, password }); }
  register(email: string, password: string) { return this.post('/api/auth/register', { email, password }); }
  getCurrentUser() { return this.get('/api/auth/me'); }

  // Clients
  getClients() { return this.get('/api/clients'); }
  getClient(id: number) { return this.get(`/api/clients/${id}`); }
  createClient(data: { name: string; description?: string; department?: string; email?: string }) {
    return this.post('/api/clients', data);
  }
  updateClient(id: number, data: { name?: string; description?: string; department?: string; email?: string }) {
    return this.put(`/api/clients/${id}`, data);
  }
  deleteClient(id: number) { return this.del(`/api/clients/${id}`); }
  deleteAllClients() { return this.del('/api/clients'); }

  // Work entries
  getWorkEntries(clientId?: number) {
    return this.get('/api/work-entries', clientId ? { params: { clientId } } : {});
  }
  getWorkEntry(id: number) { return this.get(`/api/work-entries/${id}`); }
  createWorkEntry(data: { clientId: number; hours: number; description?: string; date: string }) {
    return this.post('/api/work-entries', data);
  }
  updateWorkEntry(id: number, data: { clientId?: number; hours?: number; description?: string; date?: string }) {
    return this.put(`/api/work-entries/${id}`, data);
  }
  deleteWorkEntry(id: number) { return this.del(`/api/work-entries/${id}`); }

  // Reports
  getClientReport(clientId: number) { return this.get(`/api/reports/client/${clientId}`); }
  exportClientReportCsv(clientId: number) {
    return this.get(`/api/reports/export/csv/${clientId}`, { responseType: 'blob' });
  }
  exportClientReportPdf(clientId: number) {
    return this.get(`/api/reports/export/pdf/${clientId}`, { responseType: 'blob' });
  }

  // Health
  healthCheck() { return this.get('/health'); }
}

export const apiClient = new ApiClient();
export default apiClient;
