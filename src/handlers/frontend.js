import { loadSettings, DEFAULT_SITE_TITLE } from '../utils/settings.js';
import { parseCspOrigins, buildApiDomainsWithWs, rebuildCsp, buildBackgroundStyle } from '../utils/csp.js';

const THEME_CACHE_TTL = 3600;
const PREVIEW_COOKIE = 'cfsm_theme_preview';
const DEFAULT_CSP = "default-src 'self';script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com;style-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://fonts.googleapis.com;img-src 'self' https://challenges.cloudflare.com https://raw.githubusercontent.com data:;font-src 'self' https://challenges.cloudflare.com https://fonts.gstatic.com;connect-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com;frame-src https://challenges.cloudflare.com;form-action 'self';object-src 'none';base-uri 'self'";
const CSP_META_TAG_RE = /<meta\b(?=[^>]*http-equiv=["']Content-Security-Policy["'])[^>]*>/i;
const CSP_META_TAG_RE_GLOBAL = /<meta\b(?=[^>]*http-equiv=["']Content-Security-Policy["'])[^>]*>\s*/gi;

let filesCache = null;

async function loadFrontendFiles(env) {
  if (filesCache) return filesCache;

  try {
    const files = {};

    if (env.ASSETS) {
      try {
        const mainFiles = ['dashboard.html', 'style.css'];
        for (const filename of mainFiles) {
          try {
            const res = await env.ASSETS.fetch(new Request(`http://static/${filename}`));
            if (res.ok) {
              files[filename] = await res.text();
            }
          } catch (e) {
            // ignore missing asset binding files
          }
        }
      } catch (e) {
        console.log('[INFO] No ASSETS binding');
      }
    }

    filesCache = files;
    return filesCache;
  } catch (e) {
    console.error('[ERROR] Failed to load frontend files:', e);
    return {};
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function insertBeforeHeadClose(html, content) {
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${content}\n</head>`);
  }
  return `${content}\n${html}`;
}

function ensureCspMeta(html) {
  if (CSP_META_TAG_RE.test(html)) return html;
  return insertBeforeHeadClose(
    html,
    `<meta http-equiv="Content-Security-Policy" content="${DEFAULT_CSP}">`
  );
}

function extractCspHeader(html) {
  const tag = html.match(CSP_META_TAG_RE)?.[0] || '';
  const content = tag.match(/\bcontent=(["'])(.*?)\1/i)?.[2];
  return content || DEFAULT_CSP;
}

function stripCspMeta(html) {
  return html.replace(CSP_META_TAG_RE_GLOBAL, '');
}

function injectTitle(html, title) {
  const safeTitle = escapeHtml(title || DEFAULT_SITE_TITLE);
  if (/<title>.*?<\/title>/is.test(html)) {
    return html.replace(/<title>.*?<\/title>/is, `<title>${safeTitle}</title>`);
  }
  return insertBeforeHeadClose(html, `<title>${safeTitle}</title>`);
}

function injectAppearanceSettings(html, settings) {
  let modifiedHtml = ensureCspMeta(html);

  modifiedHtml = injectTitle(modifiedHtml, settings.site_title || DEFAULT_SITE_TITLE);

  const cspStatic = settings.csp_static || '';
  const cspApi = settings.csp_api || '';
  const staticDomains = parseCspOrigins(cspStatic);
  const rawApiDomains = parseCspOrigins(cspApi);
  const apiDomains = buildApiDomainsWithWs(rawApiDomains);

  if (staticDomains.length > 0 || apiDomains.length > 0) {
    modifiedHtml = rebuildCsp(modifiedHtml, { staticDomains, apiDomains });
  }

  if (settings.custom_head) {
    modifiedHtml = insertBeforeHeadClose(modifiedHtml, settings.custom_head);
  }

  if (settings.custom_script) {
    if (/<\/body>/i.test(modifiedHtml)) {
      modifiedHtml = modifiedHtml.replace(/<\/body>/i, `<script>${settings.custom_script}</script>\n</body>`);
    } else {
      modifiedHtml += `\n<script>${settings.custom_script}</script>`;
    }
  }

  if (settings.custom_bg) {
    modifiedHtml = insertBeforeHeadClose(modifiedHtml, buildBackgroundStyle(settings.custom_bg));
  }

  const csp = extractCspHeader(modifiedHtml);
  return {
    html: stripCspMeta(modifiedHtml),
    csp
  };
}

function getContentType(path) {
  const cleanPath = String(path || '').split('?')[0].toLowerCase();
  if (cleanPath.endsWith('.html')) return 'text/html;charset=UTF-8';
  if (cleanPath.endsWith('.js') || cleanPath.endsWith('.mjs')) return 'application/javascript;charset=UTF-8';
  if (cleanPath.endsWith('.css')) return 'text/css;charset=UTF-8';
  if (cleanPath.endsWith('.json')) return 'application/json;charset=UTF-8';
  if (cleanPath.endsWith('.svg')) return 'image/svg+xml';
  if (cleanPath.endsWith('.png')) return 'image/png';
  if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanPath.endsWith('.webp') || cleanPath.endsWith('.webpg')) return 'image/webp';
  if (cleanPath.endsWith('.gif')) return 'image/gif';
  if (cleanPath.endsWith('.ico')) return 'image/x-icon';
  if (cleanPath.endsWith('.avif')) return 'image/avif';
  if (cleanPath.endsWith('.woff')) return 'font/woff';
  if (cleanPath.endsWith('.woff2')) return 'font/woff2';
  if (cleanPath.endsWith('.ttf')) return 'font/ttf';
  if (cleanPath.endsWith('.otf')) return 'font/otf';
  if (cleanPath.endsWith('.map')) return 'application/json;charset=UTF-8';
  return 'application/octet-stream';
}

function normalizeThemeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '';
    if (url.username || url.password || url.search || url.hash) return '';

    const parts = url.pathname.split('/').filter(Boolean);
    const ref = parts[3];
    if (
      parts.length < 6 ||
      parts[0] !== 'huilang-me' ||
      parts[1] !== 'CFSM-Theme-Store' ||
      parts[2] !== 'tree' ||
      (ref !== 'dist' && !/^[0-9a-f]{40}$/i.test(ref)) ||
      parts.some(part => part === '.' || part === '..')
    ) {
      return '';
    }

    return `https://github.com/${parts.join('/')}`;
  } catch (_) {
    return '';
  }
}

function parseThemeUrl(themeUrl) {
  const normalized = normalizeThemeUrl(themeUrl);
  if (!normalized) return null;

  const url = new URL(normalized);
  const parts = url.pathname.split('/').filter(Boolean);
  const ref = parts[3];
  const themePathParts = parts.slice(4);
  const encodedThemePath = themePathParts.map(part => encodeURIComponent(part)).join('/');

  return {
    themeUrl: normalized,
    rawBase: `https://raw.githubusercontent.com/huilang-me/CFSM-Theme-Store/${ref}/${encodedThemePath}`
  };
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }
  return '';
}

function getPreviewThemeUrlFromCookie(request) {
  const value = getCookie(request, PREVIEW_COOKIE);
  if (!value) return '';
  try {
    return normalizeThemeUrl(decodeURIComponent(value));
  } catch (_) {
    return '';
  }
}

function buildPreviewCookie(request, themeUrl) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${PREVIEW_COOKIE}=${encodeURIComponent(themeUrl)}; Max-Age=${THEME_CACHE_TTL}; Path=/; SameSite=Lax${secure}`;
}

function buildClearPreviewCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${PREVIEW_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
}

function getPreviewThemeUrlFromQuery(url) {
  if (!url.searchParams.has('theme_url')) return '';
  return normalizeThemeUrl(url.searchParams.get('theme_url'));
}

function normalizeAssetPath(pathname) {
  const raw = pathname.slice('/assets/'.length);
  if (!raw) return '';

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes('\\')) return '';
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) return '';
    return parts.map(part => encodeURIComponent(part)).join('/');
  } catch (_) {
    return '';
  }
}

function normalizeThemeAssetUrls(html) {
  return html.replace(/\b(src|href)=(["'])\.?\/?assets\//gi, '$1=$2/assets/');
}

async function fetchWithCache(rawUrl, contentType) {
  const cacheKey = new Request(rawUrl, { method: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const originResponse = await fetch(rawUrl, {
    headers: { 'User-Agent': 'CFSM-Theme-Proxy' }
  });

  if (!originResponse.ok) {
    return new Response('Theme file not found', {
      status: originResponse.status,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
    });
  }

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', `public, max-age=${THEME_CACHE_TTL}`);
  headers.set('CDN-Cache-Control', `public, max-age=${THEME_CACHE_TTL}`);
  headers.set('X-Content-Type-Options', 'nosniff');

  const etag = originResponse.headers.get('ETag');
  if (etag) headers.set('ETag', etag);

  const response = new Response(originResponse.body, {
    status: 200,
    headers
  });

  if (cache) {
    await cache.put(cacheKey, response.clone()).catch(() => {});
  }

  return response;
}

async function serveThemeAsset(request, themeUrl) {
  const parsedTheme = parseThemeUrl(themeUrl);
  const url = new URL(request.url);
  const assetPath = normalizeAssetPath(url.pathname);

  if (!parsedTheme || !assetPath) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'X-CFSM-Theme-Asset': '1'
      }
    });
  }

  const response = await fetchWithCache(
    `${parsedTheme.rawBase}/assets/${assetPath}`,
    getContentType(assetPath)
  );
  const headers = new Headers(response.headers);
  headers.set('X-CFSM-Theme-Asset', '1');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function loadThemeIndex(themeUrl) {
  const parsedTheme = parseThemeUrl(themeUrl);
  if (!parsedTheme) return null;

  const response = await fetchWithCache(
    `${parsedTheme.rawBase}/index.html`,
    'text/html;charset=UTF-8'
  );

  if (!response.ok) return null;
  return normalizeThemeAssetUrls(await response.text());
}

function buildHtmlResponse(html, settings, request, previewThemeUrl = '') {
  const rendered = injectAppearanceSettings(html, settings);
  const headers = new Headers({
    'Content-Type': 'text/html;charset=UTF-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': rendered.csp
  });

  if (previewThemeUrl) {
    headers.append('Set-Cookie', buildPreviewCookie(request, previewThemeUrl));
  } else if (getPreviewThemeUrlFromCookie(request)) {
    headers.append('Set-Cookie', buildClearPreviewCookie(request));
  }

  return new Response(rendered.html, { headers });
}

function resolveThemeUrlForAsset(request, settings) {
  const url = new URL(request.url);
  return (
    getPreviewThemeUrlFromQuery(url) ||
    getPreviewThemeUrlFromCookie(request) ||
    normalizeThemeUrl(settings?.theme_url)
  );
}

function shouldUseBuiltinFrontend(path) {
  return path === '/admin' || path.startsWith('/admin/');
}

export async function serveFrontend(request, env, settings = null) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!settings) {
    settings = await loadSettings(env.DB);
  }

  if (request.method === 'GET' && path.startsWith('/assets/')) {
    const themeUrl = resolveThemeUrlForAsset(request, settings);
    if (!themeUrl) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      });
    }
    return serveThemeAsset(request, themeUrl);
  }

  const previewThemeUrl = getPreviewThemeUrlFromQuery(url);
  const configuredThemeUrl = normalizeThemeUrl(settings.theme_url);
  const effectiveThemeUrl = previewThemeUrl || configuredThemeUrl;

  if (!shouldUseBuiltinFrontend(path) && effectiveThemeUrl) {
    const themeHtml = await loadThemeIndex(effectiveThemeUrl);
    if (themeHtml) {
      return buildHtmlResponse(themeHtml, settings, request, previewThemeUrl);
    }
  }

  const files = await loadFrontendFiles(env);
  const html = files['dashboard.html'];

  if (html) {
    return buildHtmlResponse(html, settings, request);
  }

  return new Response('Frontend not available. Please build the frontend first with `npm run build:frontend`.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
  });
}
