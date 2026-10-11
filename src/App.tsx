import { useEffect, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import { parseRoute, useRoute } from './lib/router';
import { AppShell } from './components/layout/AppShell';
import { Spinner, ToastHost } from './components/kit';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { TargetsPage } from './pages/Targets';
import { ScansPage } from './pages/Scans';
import { ScanDetailPage } from './pages/ScanDetail';
import { AssetsPage } from './pages/Assets';
import { FindingsPage } from './pages/Findings';
import { ReviewPage } from './pages/Review';
import { FingerprintsPage } from './pages/Fingerprints';
import { AgentAccessPage } from './pages/AgentAccess';
import { RubricsPage } from './pages/Rubrics';
import { PocsPage } from './pages/Pocs';
import { WorkersPage } from './pages/Workers';
import { ReportsPage } from './pages/Reports';
import { ConsolePage } from './pages/PhantomVeilConsole';

function Routes() {
  const { user, ready } = useAuth();
  const path = useRoute();
  const { base, id } = parseRoute(path);

  useEffect(() => {
    if (!user && window.location.hash !== '#/login') window.location.hash = '/login';
    if (user && (base === '/login' || base === '/')) window.location.hash = '/dashboard';
  }, [user, base]);

  if (!ready) {
    return <div className="min-h-screen grid place-items-center"><Spinner label="正在启动作战台…" /></div>;
  }
  if (!user) return <LoginPage />;

  let page: ReactNode;
  switch (base) {
    case '/targets': page = <TargetsPage />; break;
    case '/scans': page = id ? <ScanDetailPage id={id} /> : <ScansPage />; break;
    case '/assets': page = <AssetsPage />; break;
    case '/findings': page = <FindingsPage />; break;
    case '/review': page = <ReviewPage />; break;
    case '/fingerprints': page = <FingerprintsPage />; break;
    case '/agent': page = <AgentAccessPage />; break;
    case '/rubrics': page = <RubricsPage />; break;
    case '/pocs': page = <PocsPage />; break;
    case '/workers': page = <WorkersPage />; break;
    case '/reports': page = <ReportsPage />; break;
    case '/console': page = <ConsolePage />; break;
    default: page = <DashboardPage />;
  }

  return <AppShell>{page}</AppShell>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes />
      <ToastHost />
    </AuthProvider>
  );
}
