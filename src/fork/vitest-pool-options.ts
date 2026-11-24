import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @lat: [[fork#Fork#Continuous integration#The suite on Node 25 and later]]
const nodeHasWebStorage = 'localStorage' in globalThis;

export const forkPoolOptions = {
  forks: {
    execArgv: nodeHasWebStorage ? ['--no-experimental-webstorage'] : [],
  },
};

// @lat: [[multi-qa-search-model#Multi-QA Search Model#Staying on the bundled model]]
export const forkTestEnvironment = {
  LAT_BUNDLED_EMBEDDING_MODEL: '1',
  // An empty config directory, so the suite never runs the knowledge stores
  // that the developer registered in their own lat config.
  XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'lat-test-config-')),
};
