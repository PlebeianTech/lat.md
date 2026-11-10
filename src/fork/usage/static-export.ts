// @lat: [[usage-dashboard#Usage Dashboard#Open the dashboard]]
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Removes the usage dashboard page from a static `lat ui build` payload. A
 * static site has no /api/usage behind it, so the page could never load data.
 * Only usage.html goes: its asset chunks may be shared with the app, and
 * nothing links to them once the page is gone.
 */
export async function removeUsageDashboard(payloadDir: string): Promise<void> {
  await rm(join(payloadDir, 'usage.html'), { force: true });
}
