// @lat: [[Specs#Config Ref]] -- see lat:ignore-config parsing bug, not an opt-out
export function realFeatureWithSubstring() {
  return 1;
}

//lat:ignore // @lat: [[Specs#Glued Ref]]
export function gluedOptOutSameLine() {
  return 2;
}

// @lat: [[Specs#Real Opt Out]] -- lat:ignore, syntax example only
export function realOptOut() {
  return 3;
}
