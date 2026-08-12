import { useState } from 'react';
import { ApiTokenControl } from './components/ApiTokenControl';
import { PlanDetailView } from './components/PlanDetailView';
import { ProjectListView } from './components/ProjectListView';
import { LanguageSwitcher } from './i18n/LanguageSwitcher';
import { useI18n } from './i18n/I18nContext';

export default function App() {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const { t } = useI18n();

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
            <button type="button" className="btn secondary" onClick={() => setSelectedPlanId(null)}>
              {t('common.backToProjects')}
            </button>
          )}
          <LanguageSwitcher />
          <ApiTokenControl onChanged={() => setAuthRevision((value) => value + 1)} />
        </div>
      </header>

      {selectedPlanId ? (
        <PlanDetailView planId={selectedPlanId} authRevision={authRevision} />
      ) : (
        <ProjectListView onSelectPlan={setSelectedPlanId} authRevision={authRevision} />
      )}
    </div>
  );
}
