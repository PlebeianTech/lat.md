// @lat: [[cli#CLI#mcp]]

export type LatMcpToolName =
  | 'lat_locate'
  | 'lat_section'
  | 'lat_search'
  | 'lat_expand'
  | 'lat_check'
  | 'lat_refs'
  | 'lat_external_list'
  | 'lat_external_show';

export const FORK_MCP_TOOL_DESCRIPTIONS: Readonly<
  Record<LatMcpToolName, string>
> = Object.freeze({
  lat_search:
    'Start here for natural-language intent queries. Returns ranked section previews and line ranges without loading whole files.',
  lat_locate:
    'Start here when part of a section heading or slug is known. Resolves exact, substring, and fuzzy section names without reading files.',
  lat_section:
    'Call after lat_search or lat_locate to load one section with its full body, outgoing links, incoming backlinks, and @lat code references. Prefer this over reading raw markdown files.',
  lat_refs:
    'Find every markdown section and @lat code reference pointing to a section ID or source file path before changing code or renaming sections.',
  lat_expand:
    'Resolve inline [[refs]] in prompt text or notes to canonical section paths, line ranges, and preview context.',
  lat_check:
    'Run after editing code or lat.md/ files to validate all wiki links, source symbols, directory indexes, Diataxis modes, and @lat code coverage.',
  lat_external_list:
    'List configured external knowledge sources without fetching or mutating caches.',
  lat_external_show:
    'Show one configured external knowledge source or exact external target without fetching remote data.',
});
