// @lat: [[usage-live-raw-events#Usage Live Raw Events#Facets count a field over the filtered set]]
export const MAX_FACET_VALUES = 20;
export const FACET_FIELDS = [
  'command',
  'agent',
  'caller',
  'surface',
  'session_id',
  'section_id',
  'error_class',
  'exit_code',
] as const;
export type FacetField = (typeof FACET_FIELDS)[number];
