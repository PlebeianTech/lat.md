/**
 * GET /api/usage/raw: raw usage and session events that match the shared
 * filters, newest first, 200 per page. Registered in live.ts.
 *
 * Parameters: `ids` (up to 50 comma-separated event ids), `cursor`, `limit`
 * (default and maximum 200), `where.<field>=<value>` (repeat it for more
 * values of one field; fields combine), `query=<text>` (usage events whose
 * search query is exactly that text), and `facet=<field>` for the top values
 * of one field instead of records. `ids`, `where.*` and `query` apply to both.
 */
import {
  FACET_FIELDS,
  MAX_PAGE_SIZE,
  facetUsageEvents,
  queryUsageEvents,
  type FacetField,
  type FieldFilters,
} from './event-index.js';
import type { UsageRouteContext } from './live.js';

const MAX_IDS = 50;
const WHERE = 'where.';

function fieldFilters(url: URL): FieldFilters {
  const where: FieldFilters = {};
  for (const name of new Set(url.searchParams.keys())) {
    if (!name.startsWith(WHERE)) continue;
    const field = name.slice(WHERE.length);
    if (!FACET_FIELDS.includes(field as FacetField))
      throw new Error(
        `Unknown filter field: ${field}. Allowed: ${FACET_FIELDS.join(', ')}`,
      );
    where[field as FacetField] = url.searchParams.getAll(name);
  }
  return where;
}

export async function rawEventsRoute({
  root,
  url,
  filters,
  bd,
  sources,
}: UsageRouteContext) {
  const param = (name: string) => url.searchParams.get(name) || undefined;
  const facet = param('facet');
  const where = fieldFilters(url);
  const query = param('query');
  const ids = param('ids')?.split(',').filter(Boolean);
  if (ids && ids.length > MAX_IDS)
    throw new Error(`At most ${MAX_IDS} ids: got ${ids.length}`);
  if (facet !== undefined) {
    if (!FACET_FIELDS.includes(facet as FacetField))
      throw new Error(
        `Unknown facet field: ${facet}. Allowed: ${FACET_FIELDS.join(', ')}`,
      );
    return facetUsageEvents(filters, facet as FacetField, {
      root,
      bd,
      sources,
      ids,
      where,
      query,
    });
  }
  const rawLimit = param('limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  return queryUsageEvents(filters, {
    root,
    bd,
    sources,
    ids,
    where,
    query,
    cursor: param('cursor'),
    limit: limit === undefined ? limit : Math.min(limit, MAX_PAGE_SIZE),
  });
}
