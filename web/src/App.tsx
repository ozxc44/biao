import { useEffect, useState } from 'react';
import {
  beginLocalOwnerSession,
  fetchHumanSession,
  getHumanSessionStatus,
  type HumanWebSessionCreated,
} from './api';
import { LocalOwnerSessionControl } from './components/LocalOwnerAccess';
import { HumanLoginPage, HumanSessionControl } from './components/HumanLoginPage';
import { PlanDetailView } from './components/PlanDetailView';
import { ProjectListView } from './components/ProjectListView';
import { LanguageSwitcher } from './i18n/LanguageSwitcher';
import { useI18n } from './i18n/I18nContext';
import { planSelectionUrl, selectedPlanFromSearch } from './navigation';
// P12 §10：SSE 实时事件订阅 → 收到任务状态变更/新门铃/冲突即刷新对应视图。
import { ignorePollEvents, useEventStream } from './hooks/useEventStream';

/** 认证通道：本机 Owner 会话 / auth_disabled 直通 / 远程人类 Cookie 会话。 */
type AuthKind = 'none' | 'local_owner' | 'auth_disabled' | 'human';

interface AuthState {
  loading: boolean;
  kind: AuthKind;
  /** loopback 本机会话入口是否可用（/auth/session.local_session_available）。 */
  localAvailable: boolean;
  /** 远程 enrollment 登录是否可用（/auth/human-session.available）。 */
  remoteAvailable: boolean;
  /** 远程会话身份（kind==='human' 时存在）。 */
  subject?: string;
  role?: string;
  /** Cookie 曾存在但已失效（提示重新申领登录码）。 */
  sessionExpired: boolean;
  error: string | null;
}

const initialAuthState: AuthState = {
  loading: true,
  kind: 'none',
  localAvailable: false,
  remoteAvailable: false,
  sessionExpired: false,
  error: null,
};

export default function App() {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : selectedPlanFromSearch(window.location.search));
  const [authRevision, setAuthRevision] = useState(0);
  const [auth, setAuth] = useState<AuthState>(initialAuthState);
  const { t } = useI18n();

  // P12 §10：SSE 实时事件订阅。认证完成后开始消费事件流；忽略后台 fallback 轮询。
  // 返回的 revision 每次有业务事件到达时递增，作为视图重载依赖（无需手动刷新）。
  const refreshRevision = useEventStream({
    enabled: !auth.loading && auth.kind !== 'none',
    filter: ignorePollEvents,
  });

  useEffect(() => {
    let cancelled = false;
    // 方案 E 双通道：先查本机会话 → 不行再查远程人类会话 → 都不行显示登录页。
    void fetchHumanSession()
      .then(async (session) => {
        if (cancelled) return;
        if (session.authenticated) {
          setAuth({
            loading: false,
            kind: session.mode === 'auth_disabled' ? 'auth_disabled' : 'local_owner',
            localAvailable: session.local_session_available,
            remoteAvailable: false,
            sessionExpired: false,
            error: null,
          });
          return;
        }
        const human = await getHumanSessionStatus();
        if (cancelled) return;
        setAuth({
          loading: false,
          kind: human.authenticated ? 'human' : 'none',
          localAvailable: session.local_session_available,
          remoteAvailable: human.available ?? false,
          subject: human.subject,
          role: human.role,
          sessionExpired: Boolean(!human.authenticated && human.expired),
          error: null,
        });
      })
      .catch((error) => {
        if (!cancelled) setAuth({
          ...initialAuthState,
          loading: false,
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
    setAuth((current) => ({
      ...current,
      loading: false,
      kind: session.authenticated ? 'local_owner' : current.kind,
      sessionExpired: false,
      error: null,
    }));
    setAuthRevision((value) => value + 1);
  };

  const enterHumanSession = (session: HumanWebSessionCreated) => {
    setAuth({
      ...auth,
      loading: false,
      kind: 'human',
      subject: session.subject,
      role: session.role,
      sessionExpired: false,
      error: null,
    });
    setAuthRevision((value) => value + 1);
  };

  const signOut = () => {
    selectPlan(null, true);
    setAuth((current) => ({
      ...current,
      kind: 'none',
      subject: undefined,
      role: undefined,
    }));
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
          {auth.kind === 'human' && auth.subject && (
            <HumanSessionControl subject={auth.subject} role={auth.role ?? ''} onSignedOut={signOut} />
          )}
          {(auth.kind === 'local_owner' || auth.kind === 'auth_disabled') && (
            <LocalOwnerSessionControl onSignedOut={signOut} />
          )}
        </div>
      </header>

      {auth.loading ? (
        <div className="notice">{t('common.loadingConsole')}</div>
      ) : auth.kind === 'none' ? (
        <HumanLoginPage
          localAvailable={auth.localAvailable}
          remoteAvailable={auth.remoteAvailable}
          error={auth.error}
          sessionExpired={auth.sessionExpired}
          onEnteredLocal={enterLocalOwnerSession}
          onEnteredHuman={enterHumanSession}
        />
      ) : selectedPlanId ? (
        <PlanDetailView planId={selectedPlanId} authRevision={authRevision} refreshRevision={refreshRevision} />
      ) : (
        <ProjectListView onSelectPlan={(planId) => selectPlan(planId)} authRevision={authRevision} refreshRevision={refreshRevision} />
      )}
    </div>
  );
}
