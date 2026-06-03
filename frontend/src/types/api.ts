export interface User {
  email: string;
  createdAt: string;
}

export interface Client {
  id: number;
  name: string;
  description: string | null;
  department: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityCode {
  id: number;
  code: string;
  name: string;
  category: string;
  description: string | null;
  created_at: string;
}

export interface WorkEntry {
  id: number;
  client_id: number;
  hours: number;
  description: string | null;
  date: string;
  activity_code_id: number | null;
  activity_code?: string;
  activity_name?: string;
  activity_category?: string;
  created_at: string;
  updated_at: string;
  client_name?: string;
}

export interface ActivityCodeSummary {
  activity_code_id: number;
  code: string;
  activity_name: string;
  category: string;
  total_hours: number;
  entry_count: number;
}

export interface CategorySummary {
  category: string;
  total_hours: number;
  entry_count: number;
}

export interface ActivityCodeDashboardData {
  byActivityCode: ActivityCodeSummary[];
  byCategory: CategorySummary[];
}

export interface WorkEntryWithClient extends WorkEntry {
  client_name: string;
}

export interface ClientReport {
  client: Client;
  workEntries: WorkEntry[];
  totalHours: number;
  entryCount: number;
}

export interface CreateClientRequest {
  name: string;
  description?: string;
  department?: string;
  email?: string;
}

export interface UpdateClientRequest {
  name?: string;
  description?: string;
  department?: string;
  email?: string;
}

export interface CreateWorkEntryRequest {
  clientId: number;
  hours: number;
  description?: string;
  date: string;
  activityCodeId?: number | null;
}

export interface UpdateWorkEntryRequest {
  clientId?: number;
  hours?: number;
  description?: string;
  date?: string;
  activityCodeId?: number | null;
}

export interface LoginRequest {
  email: string;
}

export interface LoginResponse {
  message: string;
  user: User;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}
