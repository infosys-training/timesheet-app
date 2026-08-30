export const getApiErrorMessage = (err: unknown, fallback: string): string => {
  const error = err as { response?: { data?: { error?: string } } };
  return error.response?.data?.error || fallback;
};
