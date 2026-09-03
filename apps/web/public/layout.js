(() => {
  const ua = navigator.userAgent;
  const platform = navigator.platform || '';
  const isPhone =
    /iPhone|iPod/.test(platform) ||
    /iPhone|iPod/.test(ua) ||
    (/Android.+Mobile|Windows Phone|Mobile(?!.*iPad)/i.test(ua) && !/iPad/i.test(ua));
  const isAppleTablet =
    /iPad/.test(platform) ||
    /iPad/.test(ua) ||
    (platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !/iPhone|iPod/.test(ua));
  const desktop = isAppleTablet || (!isPhone && !/Mobile(?!.*iPad)/i.test(ua));
  // Phones stay on the compact touch layout. iPad + desktop get multi-pane chrome.
  if (!desktop || isPhone) {
    delete document.documentElement.dataset.layout;
    return;
  }
  document.documentElement.dataset.layout = 'desktop';
  // Never force a synthetic 1280px viewport on iPad — it scales the page and breaks
  // nested overflow scrolling (PDF preview pan/zoom).
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) meta.setAttribute('content', 'width=device-width, initial-scale=1.0');
})();
