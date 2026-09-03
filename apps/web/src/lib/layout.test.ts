import { describe, expect, it } from 'vitest';
import {
  DEVICE_LAYOUT_VIEWPORT,
  applyRequestedLayout,
  isAppleTabletDevice,
  isAppleTouchDevice,
  isDesktopSiteRequested,
  prefersTouchWorkspace,
  shouldUseDesktopLayout,
  type LayoutNavigator,
} from './layout';

const firefoxIosDesktop =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15';
const firefoxIosIphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/604.1';
const firefoxIosIpadMobile =
  'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/604.1';
const desktopFirefox =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0';
const playwrightIpad =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
const androidPhone =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

describe('isDesktopSiteRequested', () => {
  it('treats Firefox iOS Request Desktop Site as desktop', () => {
    expect(isDesktopSiteRequested(firefoxIosDesktop)).toBe(true);
  });

  it('treats iPad mobile UAs as desktop-capable', () => {
    expect(isDesktopSiteRequested(firefoxIosIpadMobile)).toBe(true);
    expect(isDesktopSiteRequested(playwrightIpad)).toBe(true);
  });

  it('keeps iPhone and Android phone UAs on the touch layout', () => {
    expect(isDesktopSiteRequested(firefoxIosIphone)).toBe(false);
    expect(isDesktopSiteRequested(androidPhone)).toBe(false);
  });

  it('treats ordinary desktop browsers as desktop', () => {
    expect(isDesktopSiteRequested(desktopFirefox)).toBe(true);
  });
});

describe('isAppleTouchDevice', () => {
  it('detects iPadOS desktop-site spoofing', () => {
    expect(
      isAppleTouchDevice({
        userAgent: firefoxIosDesktop,
        platform: 'MacIntel',
        maxTouchPoints: 5,
        vendor: 'Apple Computer, Inc.',
      }),
    ).toBe(true);
    expect(
      isAppleTabletDevice({
        userAgent: firefoxIosDesktop,
        platform: 'MacIntel',
        maxTouchPoints: 5,
        vendor: 'Apple Computer, Inc.',
      }),
    ).toBe(true);
  });

  it('does not treat a real Mac as a touch device', () => {
    expect(
      isAppleTouchDevice({
        userAgent: desktopFirefox,
        platform: 'MacIntel',
        maxTouchPoints: 0,
        vendor: '',
      }),
    ).toBe(false);
  });
});

describe('shouldUseDesktopLayout', () => {
  it('uses the multi-pane layout on iPad hardware', () => {
    expect(
      shouldUseDesktopLayout(firefoxIosIpadMobile, {
        userAgent: firefoxIosIpadMobile,
        platform: 'iPad',
        maxTouchPoints: 5,
        vendor: 'Apple Computer, Inc.',
      }),
    ).toBe(true);
    expect(
      shouldUseDesktopLayout(firefoxIosDesktop, {
        userAgent: firefoxIosDesktop,
        platform: 'MacIntel',
        maxTouchPoints: 5,
        vendor: 'Apple Computer, Inc.',
      }),
    ).toBe(true);
  });

  it('keeps iPhone on the touch layout even with a desktop-looking request path', () => {
    expect(
      shouldUseDesktopLayout(firefoxIosIphone, {
        userAgent: firefoxIosIphone,
        platform: 'iPhone',
        maxTouchPoints: 5,
        vendor: 'Apple Computer, Inc.',
      }),
    ).toBe(false);
  });
});

describe('applyRequestedLayout', () => {
  function harness(userAgent: string, nav: LayoutNavigator) {
    const root = { dataset: {} as DOMStringMap };
    const meta = {
      content: 'width=device-width, initial-scale=1.0',
      setAttribute(_name: string, value: string) {
        this.content = value;
      },
    };
    const document = {
      documentElement: root,
      querySelector: (selector: string) => (selector === 'meta[name="viewport"]' ? meta : null),
    } as unknown as Document;
    applyRequestedLayout({ userAgent, document, navigator: nav });
    return { root, meta };
  }

  it('serves desktop layout at device width for iPad desktop-site spoofing', () => {
    const { root, meta } = harness(firefoxIosDesktop, {
      userAgent: firefoxIosDesktop,
      platform: 'MacIntel',
      maxTouchPoints: 5,
      vendor: 'Apple Computer, Inc.',
    });
    expect(root.dataset.layout).toBe('desktop');
    expect(meta.content).toBe(DEVICE_LAYOUT_VIEWPORT);
  });

  it('serves desktop layout at device width for iPad mobile UAs', () => {
    const { root, meta } = harness(firefoxIosIpadMobile, {
      userAgent: firefoxIosIpadMobile,
      platform: 'iPad',
      maxTouchPoints: 5,
      vendor: 'Apple Computer, Inc.',
    });
    expect(root.dataset.layout).toBe('desktop');
    expect(meta.content).toBe(DEVICE_LAYOUT_VIEWPORT);
  });

  it('does not alter the viewport for a real desktop browser beyond device-width', () => {
    const { root, meta } = harness(desktopFirefox, {
      userAgent: desktopFirefox,
      platform: 'MacIntel',
      maxTouchPoints: 0,
      vendor: '',
    });
    expect(root.dataset.layout).toBe('desktop');
    expect(meta.content).toBe(DEVICE_LAYOUT_VIEWPORT);
  });

  it('leaves the iPhone touch layout alone', () => {
    const { root, meta } = harness(firefoxIosIphone, {
      userAgent: firefoxIosIphone,
      platform: 'iPhone',
      maxTouchPoints: 5,
      vendor: 'Apple Computer, Inc.',
    });
    expect(root.dataset.layout).toBeUndefined();
    expect(meta.content).toBe(DEVICE_LAYOUT_VIEWPORT);
  });
});

describe('prefersTouchWorkspace', () => {
  it('does not force the touch workspace on iPad even when the touch media query would match', () => {
    expect(
      prefersTouchWorkspace(firefoxIosIpadMobile, '(hover: none)', {
        userAgent: firefoxIosIpadMobile,
        platform: 'iPad',
        maxTouchPoints: 5,
        vendor: 'Apple Computer, Inc.',
      }),
    ).toBe(false);
  });
});
