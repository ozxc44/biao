import { useEffect, useState } from 'react';
import { beginLocalOwnerSession, fetchHumanSession } from './api';
import { LocalOwnerAccessGate, LocalOwnerSessionControl } from './components/LocalOwnerAccess';
import { PlanDetailView } from './components/PlanDetailView';
import { ProjectListView } from './components/ProjectListView';
import { LanguageSwitcher } from './i18n/LanguageSwitcher';
import { useI18n } from './i18n/I18nContext';
import { planSelectionUrl, selectedPlanFromSearch } from './navigation';

export default function App() {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : selectedPlanFromSearch(window.location.search));
  const [authRevision, setAuthRevision] = useState(0);
  const [humanSession, setHumanSession] = useState<{ loading: boolean; authenticated: boolean; available: boolean; error: string | null }>({
    loading: true, authenticated: false, available: false, error: null,
  });
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    void fetchHumanSession()
      .then((session) => {
        if (!cancelled) setHumanSession({
          loading: false,
          authenticated: session.authenticated,
          available: session.local_session_available,
          error: null,
        });
      })
      .catch((error) => {
        if (!cancelled) setHumanSession({
          loading: false,
          authenticated: false,
          available: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const restoreFromUrl = () => setSelectedPlanId(selectedPlanFromSearch(window.location.search));
    window.addEventListener('popstate', restoreFromUrl);
    return () => window.removeEventListener('popstate', restoreFromUrl);
  }, []);

  const selectPlan = (planId: string | null, replace = false) => {
    const nextUrl = planSelectionUrl(window.location.href, planId);
    window.history[replace ? 'replaceState' : 'pushState']({}, '', nextUrl);
    setSelectedPlanId(planId);
  };

  const enterLocalOwnerSession = async () => {
    const session = await beginLocalOwnerSession();
    setHumanSession({ loading: false, authenticated: session.authenticated, available: session.local_session_available, error: null });
    setAuthRevision((value) => value + 1);
  };

  const signOut = () => {
    selectPlan(null, true);
    setHumanSession((current) => ({ ...current, authenticated: false }));
    setAuthRevision((value) => value + 1);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">标</span>
          <div>
            <h1>{t('app.title')}</h1>
            <p>{t('app.subtitle')}</p>
          </div>
        </div>
        <div className="header-actions">
          {selectedPlanId && (
            <button type="button" className="btn secondary" onClick={() => selectPlan(null)}>
              {t('common.backToProjects')}
            </button>
          )}
          <LanguageSwitcher />
          {humanSession.authenticated && <LocalOwnerSessionControl onSignedOut={signOut} />}
        </div>
      </header>

      {humanSession.loading ? (
        <div className="notice">{t('common.loadingConsole')}</div>
      ) : !humanSession.authenticated ? (
        <LocalOwnerAccessGate
          available={humanSession.available}
          error={humanSession.error}
          onEntered={enterLocalOwnerSession}
        />
      ) : selectedPlanId ? (
        <PlanDetailView planId={selectedPlanId} authRevision={authRevision} />
      ) : (
        <ProjectListView onSelectPlan={(planId) => selectPlan(planId)} authRevision={authRevision} />
      )}
    </div>
  );
}
