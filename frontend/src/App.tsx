// App routes (§11.2): /login, /password, the office pages under / and the driver app at /driver/*
// (a lazy chunk). Drivers who open / are sent to /driver (§11.3).
// The calendar demo build (__WMS_DEMO__, §11.5) signs in by itself and has only the office pages, without
// Users: no /login, /password, /users or /driver. Its routes live in the URL's #hash (HashRouter), so it
// runs from any sub-path of a static host that knows nothing of them.
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
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
import SubmissionsPage from './office/SubmissionsPage';
import CustomersPage from './office/CustomersPage';
import HolidaysPage from './office/HolidaysPage';
import SettingsPage from './office/SettingsPage';
import UsersPage from './office/UsersPage';

const DriverApp = __WMS_DEMO__ ? null : lazy(() => import('./driver/DriverApp'));
const Router = __WMS_DEMO__ ? HashRouter : BrowserRouter;

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
  if (!s.token && __WMS_DEMO__) return <div className="center-screen"><Loading /></div>; // the demo signs in again
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
      {!__WMS_DEMO__ && <Route path="/login" element={<LoginPage />} />}
      {!__WMS_DEMO__ && <Route path="/password" element={<ChangePasswordPage />} />}
      {DriverApp && (
        <Route
          path="/driver/*"
          element={
            <Suspense fallback={<div className="center-screen"><Loading /></div>}>
              <DriverApp />
            </Suspense>
          }
        />
      )}
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
        <Route path="submissions" element={<SubmissionsPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="settings" element={<SettingsPage />} />
        {!__WMS_DEMO__ && (
          <Route
            path="users"
            element={
              <RequireAdmin>
                <UsersPage />
              </RequireAdmin>
            }
          />
        )}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** `top`: shown above every page (the demo's banner). */
export default function App({ top }: { top?: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <SessionProvider>
              {top}
              <AppRoutes />
            </SessionProvider>
          </Router>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
