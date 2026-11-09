import type { ComponentType } from 'react';
import { AgentsPage } from './pages/agents-page';
import { ExplorePage } from './pages/explore-page';
import { FindingsPage } from './pages/findings-page';
import { IssuesPage } from './pages/issues-page';
import { KnowledgePage } from './pages/knowledge-page';
import { OverviewPage } from './pages/overview-page';
import { QueriesPage } from './pages/queries-page';
import { SessionsPage } from './pages/sessions-page';
import { UtilizationPage } from './pages/utilization-page';

/** A page gets the id from a detail path such as /_usage/sessions/<id>. */
export type UsagePageProps = { id?: string };

export type UsageRoute = {
  name: string;
  path: string;
  page: ComponentType<UsagePageProps>;
  /** Whether /_usage/<segment>/<id> opens a detail page. */
  hasDetail: boolean;
};

export const USAGE_ROUTES: UsageRoute[] = [
  { name: 'Overview', path: '/_usage', page: OverviewPage, hasDetail: false },
  {
    name: 'Findings',
    path: '/_usage/findings',
    page: FindingsPage,
    hasDetail: true,
  },
  {
    name: 'Sessions',
    path: '/_usage/sessions',
    page: SessionsPage,
    hasDetail: true,
  },
  { name: 'Issues', path: '/_usage/issues', page: IssuesPage, hasDetail: true },
  {
    name: 'Knowledge',
    path: '/_usage/knowledge',
    page: KnowledgePage,
    hasDetail: true,
  },
  {
    name: 'Queries',
    path: '/_usage/queries',
    page: QueriesPage,
    hasDetail: true,
  },
  { name: 'Agents', path: '/_usage/agents', page: AgentsPage, hasDetail: true },
  {
    name: 'Utilization',
    path: '/_usage/utilization',
    page: UtilizationPage,
    hasDetail: false,
  },
  {
    name: 'Explore',
    path: '/_usage/explore',
    page: ExplorePage,
    hasDetail: false,
  },
];

/** The route for a pathname and the decoded detail id, or undefined when no page matches. */
export function matchRoute(
  pathname: string,
): { route: UsageRoute; id?: string } | undefined {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const route of USAGE_ROUTES) {
    if (trimmed === route.path) return { route };
    if (route.hasDetail && trimmed.startsWith(`${route.path}/`)) {
      try {
        return {
          route,
          id: decodeURIComponent(trimmed.slice(route.path.length + 1)),
        };
      } catch {
        return undefined; // malformed percent escape: treat as not found
      }
    }
  }
  return undefined;
}
