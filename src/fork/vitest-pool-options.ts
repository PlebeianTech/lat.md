// @lat: [[fork#Fork#Continuous integration#The suite on Node 25 and later]]
const nodeHasWebStorage = 'localStorage' in globalThis;

export const forkPoolOptions = {
  forks: {
    execArgv: nodeHasWebStorage ? ['--no-experimental-webstorage'] : [],
  },
};
