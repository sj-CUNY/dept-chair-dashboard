'use strict';
/**
 * afterSign hook — notarizes the .app then staples the ticket to it.
 * Stapling must happen before electron-builder packages the .app into
 * the DMG, so macOS can verify offline without querying Apple's servers.
 */

const { execSync }  = require('child_process');
const { notarize }  = require('@electron/notarize');

module.exports = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Skipping — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;

  console.log(`[notarize] Submitting ${appPath} to Apple notary service…`);
  console.log('[notarize] This typically takes 2–5 minutes.');

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] Stapling ticket to .app…');
  execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });

  console.log('[notarize] Done.');
};
