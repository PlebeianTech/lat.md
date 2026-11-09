/**
 * GET /api/usage/raw: raw usage and session events that match the shared
 * filters, newest first, 200 per page. Registered in live.ts.
 *
 * Parameters: `ids` (up to 50 comma-separated event ids), `cursor`, `limit`
 * (default and maximum 200), and `facet=<field>` for the top values of one
 * field instead of records.
 */
import {
  FACET_FIELDS,
  MAX_PAGE_SIZE,
  facetUsageEvents,
  queryUsageEvents,
  type FacetField,
} from './event-index.js';
import type { UsageRouteContext } from './live.js';

const MAX_IDS = 50;

export async function rawEventsRoute({
  root,
  url,
  filters,
}: UsageRouteContext) {
  const param = (name: string) => url.searchParams.get(name) || undefined;
  const facet = param('facet');
  if (facet !== undefined) {
    if (!FACET_FIELDS.includes(facet as FacetField))
      throw new Error(
        `Unknown facet field: ${facet}. Allowed: ${FACET_FIELDS.join(', ')}`,
      );
    return facetUsageEvents(filters, facet as FacetField, { root });
  }
  const ids = param('ids')?.split(',').filter(Boolean);
  if (ids && ids.length > MAX_IDS)
    throw new Error(`At most ${MAX_IDS} ids: got ${ids.length}`);
  const rawLimit = param('limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  return queryUsageEvents(filters, {
    root,
    ids,
    cursor: param('cursor'),
    limit: limit === undefined ? limit : Math.min(limit, MAX_PAGE_SIZE),
  });
}
