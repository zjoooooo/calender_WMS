// App routes (§11.2): /login, /password, the office pages under / and the driver app at /driver/*
// (a lazy chunk). Drivers who open / are sent to /driver (§11.3).
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api';
import { I18nProvider } from './i18n';
import { homeFor, SessionProvider, useSession } from './session';
import { ToastProvider } from './ui/Toast';
import { ErrorBanner, Loading } from './ui/Feedback';
import LoginPage from './office/LoginPage';
import ChangePasswordPage from './office/ChangePasswordPage';
import OfficeLayout from './office/OfficeLayout';
import CalendarPage from './office/CalendarPage';
import RoutesPage from './office/RoutesPage';
import TasksPage from './office/TasksPage';
import CustomersPage from './office/CustomersPage';
import HolidaysPage from './office/HolidaysPage';
import SettingsPage from './office/SettingsPage';
import UsersPage from './office/UsersPage';

const DriverApp = lazy(() => import('./driver/DriverApp'));

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Do not retry rule errors (4xx); retry network / server errors twice.
        retry: (n, e) => !(e instanceof ApiError && e.http >= 400 && e.http < 500) && n < 2,
        staleTime: 10_000,
      },
      mutations: { retry: false },
    },
  });
}

const queryClient = makeQueryClient();

/** Signed in, with the password already changed; otherwise redirects. */
export function RequireUser({ children }: { children: ReactNode }) {
  const s = useSession();
  const loc = useLocation();
  if (!s.token) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (!s.me) {
    return (
      <div className="center-screen">{s.meError ? <ErrorBanner error={s.meError} onRetry={() => location.reload()} /> : <Loading />}</div>
    );
  }
  if (s.me.must_change_password) return <Navigate to="/password" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}

/** Office pages: admin and office only (a driver goes to /driver). */
function RequireOffice({ children }: { children: ReactNode }) {
  const s = useSession();
  if (s.me && !s.isOffice) return <Navigate to={homeFor(s.me)} replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const s = useSession();
  if (s.me && !s.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/password" element={<ChangePasswordPage />} />
      <Route
        path="/driver/*"
        element={
          <Suspense fallback={<div className="center-screen"><Loading /></div>}>
            <DriverApp />
          </Suspense>
        }
      />
      <Route
        path="/"
        element={
          <RequireUser>
            <RequireOffice>
              <OfficeLayout />
            </RequireOffice>
          </RequireUser>
        }
      >
        <Route index element={<CalendarPage />} />
        <Route path="routes" element={<RoutesPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route
          path="users"
          element={
            <RequireAdmin>
              <UsersPage />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <SessionProvider>
              <AppRoutes />
            </SessionProvider>
          </BrowserRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
