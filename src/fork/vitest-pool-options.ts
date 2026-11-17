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
};
