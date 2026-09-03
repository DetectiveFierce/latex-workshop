/** Phones keep the compact touch workspace. Tablets (iPad) and desktops use the multi-pane layout. */
const PHONE_UA = /iPhone|iPod|Android.+Mobile|Windows Phone|Mobile(?!.*iPad)/i;

export const TOUCH_WORKSPACE_MEDIA = '(max-width: 1200px), (hover: none) and (pointer: coarse)';
export const DEVICE_LAYOUT_VIEWPORT = 'width=device-width, initial-scale=1.0';
/** @deprecated Kept for tests/compat; desktop layout no longer forces a synthetic viewport. */
export const DESKTOP_LAYOUT_VIEWPORT = DEVICE_LAYOUT_VIEWPORT;

export type LayoutNavigator = Pick<
  Navigator,
  'platform' | 'maxTouchPoints' | 'vendor' | 'userAgent'
>;

/**
 * Firefox/Safari/Chrome on iOS “Request Desktop Site” spoofs a Macintosh UA and
 * drops Mobile/iPhone/iPad tokens. Honor that as an explicit desktop-layout request.
 * iPad mobile UAs also prefer the desktop multi-pane workspace (Magic Keyboard / trackpad).
 */
export function isDesktopSiteRequested(userAgent: string) {
  if (/iPad/i.test(userAgent)) return true;
  return !PHONE_UA.test(userAgent);
}

/** iPhone/iPad, including iPadOS 13+ and iOS desktop-site spoofing as Macintosh. */
export function isAppleTouchDevice(nav: LayoutNavigator) {
  if (/iPhone|iPad|iPod/.test(nav.platform) || /iPhone|iPad|iPod/.test(nav.userAgent)) return true;
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
}

/** True for iPhone/iPod only — not iPad (including iPadOS desktop-site spoofing). */
export function isApplePhoneDevice(nav: LayoutNavigator) {
  if (/iPhone|iPod/.test(nav.platform) || /iPhone|iPod/.test(nav.userAgent)) return true;
  return false;
}

/** iPad hardware, including iPadOS reporting itself as Macintosh. */
export function isAppleTabletDevice(nav: LayoutNavigator) {
  return isAppleTouchDevice(nav) && !isApplePhoneDevice(nav);
}

/**
 * Multi-pane desktop workspace for real desktops and iPads. Phones keep the
 * single-pane touch switcher even if the browser offers a “desktop site”.
 */
export function shouldUseDesktopLayout(
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  nav?: LayoutNavigator,
) {
  const resolved = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (resolved && isApplePhoneDevice(resolved)) return false;
  if (resolved && isAppleTabletDevice(resolved)) return true;
  return isDesktopSiteRequested(userAgent);
}

export function prefersTouchWorkspace(
  userAgent = navigator.userAgent,
  media = TOUCH_WORKSPACE_MEDIA,
  nav?: LayoutNavigator,
) {
  if (shouldUseDesktopLayout(userAgent, nav ?? navigator)) return false;
  return window.matchMedia(media).matches;
}

export function applyRequestedLayout(
  env: {
    userAgent?: string;
    document?: Document;
    navigator?: LayoutNavigator;
  } = {},
) {
  const nav = env.navigator ?? navigator;
  const doc = env.document ?? document;
  const userAgent = env.userAgent ?? nav.userAgent;
  if (!shouldUseDesktopLayout(userAgent, nav)) {
    delete doc.documentElement.dataset.layout;
    // Always restore a device-width viewport when leaving desktop layout so a prior
    // session/synthetic width cannot linger on phones.
    const meta = doc.querySelector('meta[name="viewport"]');
    if (meta) meta.setAttribute('content', DEVICE_LAYOUT_VIEWPORT);
    return false;
  }
  doc.documentElement.dataset.layout = 'desktop';
  // Keep width=device-width on iPad. A synthetic width=1280 viewport scales the page
  // and breaks overflow panning inside the PDF preview (and other nested scrollers).
  const meta = doc.querySelector('meta[name="viewport"]');
  if (meta) meta.setAttribute('content', DEVICE_LAYOUT_VIEWPORT);
  return true;
}
