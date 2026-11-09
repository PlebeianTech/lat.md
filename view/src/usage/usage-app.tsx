import type { MouseEvent } from 'react';
import { navigateTo, useUsageFilters, useUsageLocation } from './filters';
import { matchRoute, USAGE_ROUTES } from './routes';

const AGENTS = ['claude', 'codex', 'antigravity', 'pi', 'opencode'];

function FilterBar() {
  const { filters, setFilters } = useUsageFilters();
  return (
    <form
      className="usage-filters"
      onSubmit={(event) => event.preventDefault()}
    >
      <label>
        From
        <input
          type="date"
          name="from"
          value={filters.from ?? ''}
          onChange={(event) => setFilters({ from: event.target.value })}
        />
      </label>
      <label>
        To
        <input
          type="date"
          name="to"
          value={filters.to ?? ''}
          onChange={(event) => setFilters({ to: event.target.value })}
        />
      </label>
      <label>
        Agent
        <select
          name="agent"
          value={filters.agent ?? ''}
          onChange={(event) => setFilters({ agent: event.target.value })}
        >
          <option value="">All agents</option>
          {filters.agent && !AGENTS.includes(filters.agent) && (
            <option value={filters.agent}>{filters.agent}</option>
          )}
          {AGENTS.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
      </label>
      <label>
        Bd issue
        <input
          type="text"
          name="issue"
          placeholder="Includes descendants"
          value={filters.issue ?? ''}
          onChange={(event) => setFilters({ issue: event.target.value })}
        />
      </label>
      <label>
        Session
        <input
          type="text"
          name="session"
          value={filters.session ?? ''}
          onChange={(event) => setFilters({ session: event.target.value })}
        />
      </label>
    </form>
  );
}

export function UsageApp() {
  const { pathname, search } = useUsageLocation();
  const match = matchRoute(pathname);
  const Page = match?.route.page;

  function follow(event: MouseEvent<HTMLAnchorElement>, url: string) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
      return;
    event.preventDefault();
    navigateTo(url);
  }

  return (
    <div className="usage-shell">
      <nav className="usage-nav" aria-label="Usage dashboard">
        <strong className="usage-brand">lat usage</strong>
        {USAGE_ROUTES.map((route) => {
          const url = `${route.path}${search}`;
          return (
            <a
              key={route.path}
              href={url}
              aria-current={match?.route === route ? 'page' : undefined}
              onClick={(event) => follow(event, url)}
            >
              {route.name}
            </a>
          );
        })}
      </nav>
      <div className="usage-body">
        <FilterBar />
        <main className="usage-content">
          {Page ? <Page id={match.id} /> : <p>Page not found.</p>}
        </main>
      </div>
    </div>
  );
}
