// This fixture has documents and source files but shipped no `@lat:` marker,
// which upstream's checks do not mind and this fork's coverage floor does. The
// marker lives in its own file so upstream's app.ts keeps its exact contents
// and symbol line numbers.
//
// @lat: [[lat#Source Reference Fixture]]
export const COVERAGE_MARKER = true;
