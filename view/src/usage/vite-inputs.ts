import { join } from 'node:path';

/** Both HTML entries of the lat ui build: the upstream app and the usage dashboard. */
export function forkViewInputs(viewRoot: string): Record<string, string> {
  return {
    index: join(viewRoot, 'index.html'),
    usage: join(viewRoot, 'usage.html'),
  };
}
