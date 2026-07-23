#!/usr/bin/env node
/**
 * Deploy the signed field iOS IPA to Vercel Blob (plan 010, Phase 5 — enterprise
 * in-house distribution). Run by the `build-field-ios.yml` deploy job after the
 * build job uploads the IPA artifact:
 *
 *   pnpm --filter @rfid/web exec node scripts/deploy-field-ipa.mjs \
 *     --ipa ./ipa/RField.ipa \
 *     --build-number 42 \
 *     --marketing-version 1.0.0 \
 *     --bundle-id com.brasfieldgorrie.rfid-field \
 *     --display-name "RFID Field"
 *
 * Uploads the IPA to `field-ios/{marketingVersion}/{buildNumber}.ipa` and a
 * `field-ios/latest.json` describing it, both to the private `rfid-bol` store
 * (the web app's existing Blob store). The store is private, so the IPA is
 * served to iOS at install time via a short-lived presigned GET URL minted by
 * the `/api/field/manifest.plist` route — the read-write token never leaves the
 * server. `multipart: true` streams large IPAs without buffering the whole
 * body in one request. `addRandomSuffix: false` + `allowOverwrite: true` keeps
 * the path stable and content-addressed (a re-deploy of the same build
 * overwrites in place).
 *
 * Required env: BLOB_READ_WRITE_TOKEN (the web app's Blob store RW token).
 */
import { readFile } from "node:fs/promises";
import { put } from "@vercel/blob";

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return null;
  return process.argv[idx + 1];
}

function fail(msg) {
  console.error(`deploy-field-ipa: ${msg}`);
  process.exit(1);
}

const IPA_PATH = arg("ipa");
const BUILD_NUMBER = arg("build-number");
const MARKETING_VERSION = arg("marketing-version");
const BUNDLE_ID = arg("bundle-id");
const DISPLAY_NAME = arg("display-name");
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

if (!IPA_PATH || !BUILD_NUMBER || !MARKETING_VERSION || !BUNDLE_ID || !DISPLAY_NAME) {
  fail(
    "missing required --ipa/--build-number/--marketing-version/--bundle-id/--display-name",
  );
}
if (!TOKEN) {
  fail(
    "BLOB_READ_WRITE_TOKEN is not set; set it in the GitHub environment (see docs/operations/ios-ci-secrets.md).",
  );
}

const IPA_PATHNAME = `field-ios/${MARKETING_VERSION}/${BUILD_NUMBER}.ipa`;
const LATEST_PATHNAME = "field-ios/latest.json";

const latestJson = {
  buildNumber: String(BUILD_NUMBER),
  marketingVersion: MARKETING_VERSION,
  bundleId: BUNDLE_ID,
  displayName: DISPLAY_NAME,
  ipaPath: IPA_PATHNAME,
  uploadedAt: new Date().toISOString(),
};

console.log(`deploy-field-ipa: uploading IPA → ${IPA_PATHNAME}`);
const ipaBytes = await readFile(IPA_PATH);
const ipaResult = await put(IPA_PATHNAME, ipaBytes, {
  access: "private",
  addRandomSuffix: false,
  allowOverwrite: true,
  multipart: true,
  contentType: "application/octet-stream",
  token: TOKEN,
});
console.log(`deploy-field-ipa: IPA uploaded → ${ipaResult.url}`);

console.log(`deploy-field-ipa: uploading latest.json → ${LATEST_PATHNAME}`);
const latestResult = await put(LATEST_PATHNAME, JSON.stringify(latestJson, null, 2), {
  access: "private",
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "application/json",
  token: TOKEN,
});
console.log(`deploy-field-ipa: latest.json uploaded → ${latestResult.url}`);

console.log(
  `deploy-field-ipa: done. version=${MARKETING_VERSION}+${BUILD_NUMBER} bundleId=${BUNDLE_ID}`,
);
