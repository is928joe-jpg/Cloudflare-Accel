// ================= 用户配置区域 =================

// 白名单域名
const ALLOWED_HOSTS = [
  'quay.io',
  'gcr.io',
  'k8s.gcr.io',
  'registry.k8s.io',
  'ghcr.io',
  'docker.cloudsmith.io',
  'registry-1.docker.io',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com'
];

const RESTRICT_PATHS = false;

const ALLOWED_PATHS = [
  'library',
  'user-id-1',
  'user-id-2',
];

// ================= 前端 HTML 和 JS 保持原样 =================
// HOMEPAGE_HTML 等前端内容保持不变
// 省略展示，直接保留你的原始 HOMEPAGE_HTML 变量和前端 JS
// ============================================================


// ================= token 处理 =================

// 从环境变量读取 REPO_TOKENS 并解析成对象数组
function getRepoTokensFromEnv(env) {
  try {
    if (env.REPO_TOKENS) {
      return JSON.parse(env.REPO_TOKENS);
    }
  } catch (e) {
    console.error('Failed to parse REPO_TOKENS from env:', e);
  }
  return [];
}

// 获取最终用于 Authorization 的 token
function getEffectiveToken(targetUrl, env) {
  const REPO_TOKENS = getRepoTokensFromEnv(env);

  // 优先匹配配置对象
  const tokenEntry = REPO_TOKENS.find(entry =>
    targetUrl.startsWith(entry.url) &&
    entry.url_token && targetUrl.includes(entry.url_token)
  );
  if (tokenEntry) return tokenEntry.repo_token;

  // 回退：尝试从 URL 提取 token
  try {
    const urlObj = new URL(targetUrl);
    let urlToken = null;

    // @token 格式
    const atTokenMatch = urlObj.pathname.match(/@([^@:]+)(:|$)/);
    if (atTokenMatch) urlToken = atTokenMatch[1];

    // ?token=xxx 查询参数
    if (!urlToken && urlObj.searchParams.has('token')) {
      urlToken = urlObj.searchParams.get('token');
    }

    return urlToken || null; // 默认匿名
  } catch {
    return null; // URL 解析失败
  }
}

// ================= 其他辅助函数 =================

async function handleToken(realm, service, scope) {
  const tokenUrl = `${realm}?service=${service}&scope=${scope}`;
  try {
    const tokenResponse = await fetch(tokenUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (!tokenResponse.ok) return null;
    const tokenData = await tokenResponse.json();
    return tokenData.token || tokenData.access_token || null;
  } catch {
    return null;
  }
}

function isAmazonS3(url) {
  try {
    return new URL(url).hostname.includes('amazonaws.com');
  } catch {
    return false;
  }
}

function getEmptyBodySHA256() {
  return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
}

// ================== Worker 主逻辑 ==================

async function handleRequest(request, redirectCount = 0, env) {
  const MAX_REDIRECTS = 5;
  const url = new URL(request.url);
  let path = url.pathname;

  if (path === '/' || path === '') {
    return new Response(HOMEPAGE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // 处理 Docker V2 API 或 GitHub 代理请求
  let isV2Request = false;
  let v2RequestType = null;
  let v2RequestTag = null;
  if (path.startsWith('/v2/')) {
    isV2Request = true;
    path = path.replace('/v2/', '');
    const pathSegments = path.split('/').filter(p => p);
    if (pathSegments.length >= 3) {
      v2RequestType = pathSegments[pathSegments.length - 2];
      v2RequestTag = pathSegments[pathSegments.length - 1];
      path = pathSegments.slice(0, pathSegments.length - 2).join('/');
    }
  }

  const pathParts = path.split('/').filter(p => p);
  if (pathParts.length < 1) return new Response('Invalid request\n', { status: 400 });

  let targetDomain, targetPath, isDockerRequest = false;
  const fullPath = path.startsWith('/') ? path.substring(1) : path;

  if (fullPath.startsWith('https://') || fullPath.startsWith('http://')) {
    const urlObj = new URL(fullPath);
    targetDomain = urlObj.hostname;
    targetPath = urlObj.pathname.substring(1) + urlObj.search;
    isDockerRequest = ['quay.io','gcr.io','k8s.gcr.io','registry.k8s.io','ghcr.io','docker.cloudsmith.io','registry-1.docker.io','docker.io'].includes(targetDomain);
    if (targetDomain === 'docker.io') targetDomain = 'registry-1.docker.io';
  } else {
    if (pathParts[0] === 'docker.io') {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.length === 2 ? `library/${pathParts[1]}` : pathParts.slice(1).join('/');
    } else if (ALLOWED_HOSTS.includes(pathParts[0])) {
      targetDomain = pathParts[0];
      targetPath = pathParts.slice(1).join('/') + url.search;
      isDockerRequest = ['quay.io','gcr.io','k8s.gcr.io','registry.k8s.io','ghcr.io','docker.cloudsmith.io','registry-1.docker.io'].includes(targetDomain);
    } else if (pathParts.length >= 1 && pathParts[0] === 'library') {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.join('/');
    } else if (pathParts.length >= 2) {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.join('/');
    } else {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = `library/${pathParts.join('/')}`;
    }
  }

  if (!ALLOWED_HOSTS.includes(targetDomain)) return new Response(`Error: Invalid target domain.\n`, { status: 400 });

  if (RESTRICT_PATHS) {
    const checkPath = isDockerRequest ? targetPath : path;
    const isPathAllowed = ALLOWED_PATHS.some(p => checkPath.toLowerCase().includes(p.toLowerCase()));
    if (!isPathAllowed) return new Response(`Error: Path not allowed\n`, { status: 403 });
  }

  let targetUrl = isDockerRequest
    ? (isV2Request && v2RequestType && v2RequestTag
       ? `https://${targetDomain}/v2/${targetPath}/${v2RequestType}/${v2RequestTag}`
       : `https://${targetDomain}/${isV2Request ? 'v2/' : ''}${targetPath}`)
    : `https://${targetDomain}/${targetPath}`;

  const newRequestHeaders = new Headers(request.headers);
  newRequestHeaders.set('Host', targetDomain);
  newRequestHeaders.delete('x-amz-content-sha256');
  newRequestHeaders.delete('x-amz-date');
  newRequestHeaders.delete('x-amz-security-token');
  newRequestHeaders.delete('x-amz-user-agent');

  // ===== token 注入 =====
  const effectiveToken = getEffectiveToken(targetUrl, env);
  if (effectiveToken) newRequestHeaders.set('Authorization', `Bearer ${effectiveToken}`);
  else newRequestHeaders.delete('Authorization');
  // ====================

  if (isAmazonS3(targetUrl)) {
    newRequestHeaders.set('x-amz-content-sha256', getEmptyBodySHA256());
    newRequestHeaders.set('x-amz-date', new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5)+'Z');
  }

  try {
    let response = await fetch(targetUrl, {
      method: request.method,
      headers: newRequestHeaders,
      body: request.body,
      redirect: 'manual'
    });

    // Docker 401 处理
    if (isDockerRequest && response.status === 401) {
      const wwwAuth = response.headers.get('WWW-Authenticate');
      if (wwwAuth) {
        const authMatch = wwwAuth.match(/Bearer realm="([^"]+)",service="([^"]*)",scope="([^"]*)"/);
        if (authMatch) {
          const [, realm, service, scope] = authMatch;
          const token = await handleToken(realm, service || targetDomain, scope);
          if (token) {
            const authHeaders = new Headers(request.headers);
            authHeaders.set('Authorization', `Bearer ${token}`);
            authHeaders.set('Host', targetDomain);
            if (isAmazonS3(targetUrl)) {
              authHeaders.set('x-amz-content-sha256', getEmptyBodySHA256());
              authHeaders.set('x-amz-date', new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5)+'Z');
            }
            response = await fetch(new Request(targetUrl, { method: request.method, headers: authHeaders, body: request.body, redirect: 'manual' }));
          }
        }
      }
    }

    // Docker / S3 重定向处理
    if (isDockerRequest && (response.status === 302 || response.status === 307)) {
      const redirectUrl = response.headers.get('Location');
      if (redirectUrl) {
        const redirectHeaders = new Headers(request.headers);
        redirectHeaders.set('Host', new URL(redirectUrl).hostname);
        if (isAmazonS3(redirectUrl)) {
          redirectHeaders.set('x-amz-content-sha256', getEmptyBodySHA256());
          redirectHeaders.set('x-amz-date', new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5)+'Z');
        }
        if (response.headers.get('Authorization')) {
          redirectHeaders.set('Authorization', response.headers.get('Authorization'));
        }
        response = await fetch(new Request(redirectUrl, { method: request.method, headers: redirectHeaders, body: request.body, redirect: 'manual' }));
      }
    }

    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin','*');
    newResponse.headers.set('Access-Control-Allow-Methods','GET, HEAD, POST, OPTIONS');
    if (isDockerRequest) {
      newResponse.headers.set('Docker-Distribution-API-Version','registry/2.0');
      newResponse.headers.delete('Location');
    }

    return newResponse;
  } catch (e) {
    return new Response(`Error fetching from ${targetDomain}: ${e.message}\n`, { status: 500 });
  }
}

// ================== Worker 导出 ==================
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, 0, env);
  }
};
