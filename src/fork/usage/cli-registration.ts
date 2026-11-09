import type { Command } from 'commander';
import { registerImpactCommand } from '../../cli/impact.js';
import { installCliTap } from './cli-tap.js';
import { registerUsageCommand } from './usage-cli.js';

export function registerForkCli(program: Command): void {
  installCliTap(program);
  registerImpactCommand(program);
  registerUsageCommand(program);
}
