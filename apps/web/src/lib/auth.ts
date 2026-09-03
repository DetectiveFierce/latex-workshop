import { createAuthClient } from 'better-auth/react';
import { appPath } from './api';

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: appPath('/api/auth'),
});
