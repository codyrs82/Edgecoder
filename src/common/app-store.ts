// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** EdgeCoder for iPhone and iPad on the App Store (App Store Connect app id). */
export const IOS_APP_STORE_ID = "6759273340";
export const IOS_APP_STORE_URL = `https://apps.apple.com/app/id${IOS_APP_STORE_ID}`;

/**
 * Safari's Smart App Banner: on iPhone and iPad, Safari shows a "Get EdgeCoder" bar (or "Open" when
 * the app is installed) above any page that carries this tag. Other browsers ignore it.
 */
export function smartAppBannerTag(): string {
  return `<meta name="apple-itunes-app" content="app-id=${IOS_APP_STORE_ID}" />`;
}
