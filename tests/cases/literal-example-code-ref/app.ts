// @lat: [[Specs#Real Ref]]
export function realFeature() {
  return 1;
}

// Docs on the syntax: a `// @lat: [[section-id]]` pointer names a section.
export function documentedSyntax() {
  return 2;
}

const fixture = '// @lat: [[does-not-exist]]\nexport const X = 1;\n';

// @lat: [[also-fake]] -- lat:ignore, syntax example only, not a real ref
export function ignoredViaOptOut() {
  return 3;
}
