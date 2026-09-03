import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { authClient } from './lib/auth';
import { APP_BASE } from './lib/api';
import { applyAppearance } from './lib/appearance';
import { applyRequestedLayout } from './lib/layout';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './styles/theme.css';
import './styles/app.css';

applyRequestedLayout();
applyAppearance();

const AuthPage = lazy(() =>
  import('./routes/AuthPage').then(({ AuthPage: component }) => ({ default: component })),
);
const DashboardPage = lazy(() =>
  import('./routes/DashboardPage').then(({ DashboardPage: component }) => ({ default: component })),
);
const AccountPage = lazy(() =>
  import('./routes/AccountPage').then(({ AccountPage: component }) => ({ default: component })),
);
const WorkspacePage = lazy(() => import('./routes/WorkspacePage'));
const PdfPage = lazy(() => import('./routes/PdfPage'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 }, mutations: { retry: 0 } },
});

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    throw redirect({ to: data?.user ? '/projects' : '/auth' });
  },
});
const authRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth',
  component: () => (
    <Suspense fallback={<FullScreenLoader label="Opening account…" />}>
      <AuthPage />
    </Suspense>
  ),
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    view?: 'all' | 'recent' | 'favorites' | 'templates' | 'folder' | 'tag' | 'trash';
    folder?: string;
    tag?: string;
    q?: string;
    sort?: 'updated-desc' | 'updated-asc' | 'created-desc' | 'name-asc' | 'name-desc';
  } => {
    const view = String(search.view);
    const sort = String(search.sort);
    return {
      ...(['all', 'recent', 'favorites', 'templates', 'folder', 'tag', 'trash'].includes(view)
        ? {
            view: view as 'all' | 'recent' | 'favorites' | 'templates' | 'folder' | 'tag' | 'trash',
          }
        : {}),
      ...(typeof search.folder === 'string' ? { folder: search.folder } : {}),
      ...(typeof search.tag === 'string' ? { tag: search.tag } : {}),
      ...(typeof search.q === 'string' ? { q: search.q } : {}),
      ...(['updated-desc', 'updated-asc', 'created-desc', 'name-asc', 'name-desc'].includes(sort)
        ? {
            sort: sort as
              | 'updated-desc'
              | 'updated-asc'
              | 'created-desc'
              | 'name-asc'
              | 'name-desc',
          }
        : {}),
    };
  },
  component: () => (
    <Suspense fallback={<FullScreenLoader label="Opening library…" />}>
      <DashboardPage />
    </Suspense>
  ),
});
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  component: () => (
    <Suspense fallback={<FullScreenLoader label="Opening settings…" />}>
      <AccountPage />
    </Suspense>
  ),
});
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: () => (
    <Suspense fallback={<FullScreenLoader label="Opening workspace…" />}>
      <WorkspacePage />
    </Suspense>
  ),
});
const pdfRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/pdf/$jobId',
  component: () => (
    <Suspense fallback={<FullScreenLoader label="Loading PDF…" />}>
      <PdfPage />
    </Suspense>
  ),
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  authRoute,
  projectsRoute,
  accountRoute,
  workspaceRoute,
  pdfRoute,
]);
const router = createRouter({ routeTree, basepath: APP_BASE || '/' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

function FullScreenLoader({ label }: { label: string }) {
  return (
    <main className="screen-center">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
