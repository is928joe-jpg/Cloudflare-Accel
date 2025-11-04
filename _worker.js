//================ _worker.js =============================
// 更新日期: 2025-11-04
// 功能: Cloudflare 加速 Docker/GitHub + AWS S3 自动 x-amz 头 + 私有 token + 多重重定向

// 用户配置区域开始 =================================
// 从环境变量读取配置，如果没有则使用默认值
function getConfig(env) {
  // TOKEN_MAPPING 格式: ["url@ENV_VAR","url2@ENV_VAR2", ...]
  const TOKEN_MAPPING = env.TOKEN_MAPPING || '[]';
  
  const ALLOWED_HOSTS = env.ALLOWED_HOSTS || [
    'quay.io', 'gcr.io', 'k8s.gcr.io', 'registry.k8s.io',
    'ghcr.io', 'docker.cloudsmith.io', 'registry-1.docker.io',
    'github.com', 'api.github.com', 'raw.githubusercontent.com',
    'gist.github.com', 'gist.githubusercontent.com'
  ];

  const RESTRICT_PATHS = env.RESTRICT_PATHS || false;
  
  const ALLOWED_PATHS = env.ALLOWED_PATHS || [
    'library',   // Docker Hub 官方镜像仓库的命名空间
    'user-id-1',
    'user-id-2'
  ];

  return {
    TOKEN_MAPPING,
    ALLOWED_HOSTS: typeof ALLOWED_HOSTS === 'string' ? JSON.parse(ALLOWED_HOSTS) : ALLOWED_HOSTS,
    RESTRICT_PATHS: typeof RESTRICT_PATHS === 'string' ? RESTRICT_PATHS === 'true' : RESTRICT_PATHS,
    ALLOWED_PATHS: typeof ALLOWED_PATHS === 'string' ? JSON.parse(ALLOWED_PATHS) : ALLOWED_PATHS
  };
}

// TOKEN_MAPPING 改为 JSON 字符串形式，一次性读取,CF 面板中格式
// 方式1：逗号分隔（单行）
// https://raw.githubusercontent.com/is928joe-jpg@REPO_TOKEN_1,https://api.github.com/repos/private-org@REPO_TOKEN_2

// 方式2：换行分隔（多行）
// https://raw.githubusercontent.com/is928joe-jpg@REPO_TOKEN_1
// https://api.github.com/repos/private-org@REPO_TOKEN_2

// 方式3：混合分隔
// https://raw.githubusercontent.com/is928joe-jpg@REPO_TOKEN_1,
// https://api.github.com/repos/private-org@REPO_TOKEN_2
 
function parseTokenMapping(env) {
  const mappingStr = env.TOKEN_MAPPING || '';
  return mappingStr
    .split(/[\n,]/)      // 按换行或逗号分割
    .map(s => s.trim())  // 去掉首尾空格
    .filter(Boolean)     // 忽略空行
    .map(item => {
      const [url, env_var] = item.split('@');
      return { url, env_var };
    });
}

// 用户配置区域结束 =================================

// 闪电 SVG
const LIGHTNING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>`;

// 首页 HTML（完整功能版）
const HOMEPAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare 加速</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(LIGHTNING_SVG)}">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Inter', sans-serif;
      transition: background-color 0.3s, color 0.3s;
      padding: 1rem;
    }
    .light-mode {
      background: linear-gradient(to bottom right, #f1f5f9, #e2e8f0);
      color: #111827;
    }
    .dark-mode {
      background: linear-gradient(to bottom right, #1f2937, #374151);
      color: #e5e7eb;
    }
    .container {
      width: 100%;
      max-width: 800px;
      padding: 1.5rem;
      border-radius: 0.75rem;
      border: 1px solid #e5e7eb;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
    }
    .light-mode .container {
      background: #ffffff;
    }
    .dark-mode .container {
      background: #1f2937;
    }
    .section-box {
      background: linear-gradient(to bottom, #ffffff, #f3f4f6);
      border-radius: 0.5rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
    }
    .dark-mode .section-box {
      background: linear-gradient(to bottom, #374151, #1f2937);
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    }
    .theme-toggle {
      position: fixed;
      top: 0.5rem;
      right: 0.5rem;
      padding: 0.5rem;
      font-size: 1.2rem;
    }
    .toast {
      position: fixed;
      bottom: 1rem;
      left: 50%;
      transform: translateX(-50%);
      background: #10b981;
      color: white;
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      opacity: 0;
      transition: opacity 0.3s;
      font-size: 0.9rem;
      max-width: 90%;
      text-align: center;
    }
    .toast.show {
      opacity: 1;
    }
    .result-text {
      word-break: break-all;
      overflow-wrap: break-word;
      font-size: 0.95rem;
      max-width: 100%;
      padding: 0.5rem;
      border-radius: 0.25rem;
      background: #f3f4f6;
    }
    .dark-mode .result-text {
      background: #2d3748;
    }

    input[type="text"] {
      background-color: white !important;
      color: #111827 !important;
    }
    .dark-mode input[type="text"] {
      background-color: #374151 !important;
      color: #e5e7eb !important;
    }

    @media (max-width: 640px) {
      .container {
        padding: 1rem;
      }
      .section-box {
        padding: 1rem;
        margin-bottom: 1rem;
      }
      h1 {
        font-size: 1.5rem;
        margin-bottom: 1.5rem;
      }
      h2 {
        font-size: 1.25rem;
        margin-bottom: 0.75rem;
      }
      p {
        font-size: 0.875rem;
      }
      input {
        font-size: 0.875rem;
        padding: 0.5rem;
        min-height: 44px;
      }
      button {
        font-size: 0.875rem;
        padding: 0.5rem 1rem;
        min-height: 44px;
      }
      .flex.gap-2 {
        flex-direction: column;
        gap: 0.5rem;
      }
      .github-buttons, .docker-buttons {
        flex-direction: column;
        gap: 0.5rem;
      }
      .result-text {
        font-size: 0.8rem;
        padding: 0.4rem;
      }
      footer {
        font-size: 0.75rem;
      }
    }
  </style>
</head>
<body class="light-mode">
  <button onclick="toggleTheme()" class="theme-toggle bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-full hover:bg-gray-300 dark:hover:bg-gray-600 transition">
    <span class="sun">☀️</span>
    <span class="moon hidden">🌙</span>
  </button>
  <div class="container mx-auto">
    <h1 class="text-3xl font-bold text-center mb-8">Cloudflare 加速下载</h1>

    <!-- GitHub 链接转换 -->
    <div class="section-box">
      <h2 class="text-xl font-semibold mb-2">⚡ GitHub 文件加速</h2>
      <p class="text-gray-600 dark:text-gray-300 mb-4">输入 GitHub 文件链接，自动转换为加速链接。也可以直接在链接前加上本站域名使用。</p>
      <div class="flex gap-2 mb-2">
        <input
          id="github-url"
          type="text"
          placeholder="请输入 GitHub 文件链接，例如：https://github.com/user/repo/releases/..."
          class="flex-grow p-2 border border-gray-400 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
        >
        <button
          onclick="convertGithubUrl()"
          class="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition"
        >
          获取加速链接
        </button>
      </div>
      <p id="github-result" class="mt-2 text-green-600 dark:text-green-400 result-text hidden"></p>
      <div id="github-buttons" class="flex gap-2 mt-2 github-buttons hidden">
        <button onclick="copyGithubUrl()" class="bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200 px-3 py-1 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 transition w-full">📋 复制链接</button>
        <button onclick="openGithubUrl()" class="bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200 px-3 py-1 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 transition w-full">🔗 打开链接</button>
      </div>
    </div>

    <!-- Docker 镜像加速 -->
    <div class="section-box">
      <h2 class="text-xl font-semibold mb-2">🐳 Docker 镜像加速</h2>
      <p class="text-gray-600 dark:text-gray-300 mb-4">输入原镜像地址（如 hello-world 或 ghcr.io/user/repo），获取加速拉取命令。</p>
      <div class="flex gap-2 mb-2">
        <input
          id="docker-image"
          type="text"
          placeholder="请输入镜像地址，例如：hello-world 或 ghcr.io/user/repo"
          class="flex-grow p-2 border border-gray-400 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
        >
        <button
          onclick="convertDockerImage()"
          class="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition"
        >
          获取加速命令
        </button>
      </div>
      <p id="docker-result" class="mt-2 text-green-600 dark:text-green-400 result-text hidden"></p>
      <div id="docker-buttons" class="flex gap-2 mt-2 docker-buttons hidden">
        <button onclick="copyDockerCommand()" class="bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200 px-3 py-1 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 transition w-full">📋 复制命令</button>
      </div>
    </div>

    <footer class="mt-6 text-center text-gray-500 dark:text-gray-400">
      Powered by <a href="https://github.com/fscarmen2/Cloudflare-Accel" class="text-blue-500 hover:underline">fscarmen2/Cloudflare-Accel</a>
    </footer>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    // 动态获取当前域名
    const currentDomain = window.location.hostname;

    // 主题切换
    function toggleTheme() {
      const body = document.body;
      const sun = document.querySelector('.sun');
      const moon = document.querySelector('.moon');
      if (body.classList.contains('light-mode')) {
        body.classList.remove('light-mode');
        body.classList.add('dark-mode');
        sun.classList.add('hidden');
        moon.classList.remove('hidden');
        localStorage.setItem('theme', 'dark');
      } else {
        body.classList.remove('dark-mode');
        body.classList.add('light-mode');
        moon.classList.add('hidden');
        sun.classList.remove('hidden');
        localStorage.setItem('theme', 'light');
      }
    }

    // 初始化主题
    if (localStorage.getItem('theme') === 'dark') {
      toggleTheme();
    }

    // 显示弹窗提示
    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.classList.remove(isError ? 'bg-green-500' : 'bg-red-500');
      toast.classList.add(isError ? 'bg-red-500' : 'bg-green-500');
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
    }

    // 复制文本的通用函数
    function copyToClipboard(text) {
      // 尝试使用 navigator.clipboard API
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).catch(err => {
          console.error('Clipboard API failed:', err);
          return false;
        });
      }
      // 后备方案：使用 document.execCommand
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        return successful ? Promise.resolve() : Promise.reject(new Error('Copy command failed'));
      } catch (err) {
        document.body.removeChild(textarea);
        return Promise.reject(err);
      }
    }

    // GitHub 链接转换
    let githubAcceleratedUrl = '';
    function convertGithubUrl() {
      const input = document.getElementById('github-url').value.trim();
      const result = document.getElementById('github-result');
      const buttons = document.getElementById('github-buttons');
      if (!input) {
        showToast('请输入有效的 GitHub 链接', true);
        result.classList.add('hidden');
        buttons.classList.add('hidden');
        return;
      }
      if (!input.startsWith('https://')) {
        showToast('链接必须以 https:// 开头', true);
        result.classList.add('hidden');
        buttons.classList.add('hidden');
        return;
      }

      // 保持现有格式：域名/https://原始链接
      githubAcceleratedUrl = 'https://' + currentDomain + '/https://' + input.substring(8);
      result.textContent = '加速链接: ' + githubAcceleratedUrl;
      result.classList.remove('hidden');
      buttons.classList.remove('hidden');
      copyToClipboard(githubAcceleratedUrl).then(() => {
        showToast('已复制到剪贴板');
      }).catch(err => {
        showToast('复制失败: ' + err.message, true);
      });
    }

    function copyGithubUrl() {
      copyToClipboard(githubAcceleratedUrl).then(() => {
        showToast('已手动复制到剪贴板');
      }).catch(err => {
        showToast('手动复制失败: ' + err.message, true);
      });
    }

    function openGithubUrl() {
      window.open(githubAcceleratedUrl, '_blank');
    }

    // Docker 镜像转换
    let dockerCommand = '';
    function convertDockerImage() {
      const input = document.getElementById('docker-image').value.trim();
      const result = document.getElementById('docker-result');
      const buttons = document.getElementById('docker-buttons');
      if (!input) {
        showToast('请输入有效的镜像地址', true);
        result.classList.add('hidden');
        buttons.classList.add('hidden');
        return;
      }
      dockerCommand = 'docker pull ' + currentDomain + '/' + input;
      result.textContent = '加速命令: ' + dockerCommand;
      result.classList.remove('hidden');
      buttons.classList.remove('hidden');
      copyToClipboard(dockerCommand).then(() => {
        showToast('已复制到剪贴板');
      }).catch(err => {
        showToast('复制失败: ' + err.message, true);
      });
    }

    function copyDockerCommand() {
      copyToClipboard(dockerCommand).then(() => {
        showToast('已手动复制到剪贴板');
      }).catch(err => {
        showToast('手动复制失败: ' + err.message, true);
      });
    }
  </script>
</body>
</html>`;

// 获取私有 token
function getPrivateToken(targetUrl, env, tokenMapping) {
  const matched = tokenMapping.find(cfg => targetUrl.startsWith(cfg.url));
  if (matched && env[matched.env_var]) return env[matched.env_var];
  return null;
}

function isAmazonS3(url) {
  try { return new URL(url).hostname.includes('amazonaws.com'); } catch { return false; }
}

function getEmptyBodySHA256() {
  return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
}

async function handleToken(realm, service, scope, env, targetUrl, tokenMapping) {
  const privateToken = getPrivateToken(targetUrl, env, tokenMapping);
  if (privateToken) return privateToken;
  try {
    const resp = await fetch(`${realm}?service=${service}&scope=${scope}`, { headers: { Accept: 'application/json' } });
    const data = await resp.json();
    return data.token || data.access_token || null;
  } catch { return null; }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  
  // 获取配置
  const config = getConfig(env);
  const tokenMapping = parseTokenMapping(env);
  
  // 首页路由
  if (url.pathname === '/' || url.pathname === '') {
    return new Response(HOMEPAGE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  let path = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
  let pathParts = path.split('/').filter(Boolean);
  
  // 处理空路径情况
  if (pathParts.length === 0) {
    return new Response('Invalid request path\n', { status: 400 });
  }

  let targetDomain, targetPath, isDockerRequest = false;

  // 检查是否是完整 URL 格式
  if (path.startsWith('https://') || path.startsWith('http://')) {
    const u = new URL(path);
    targetDomain = u.hostname;
    targetPath = u.pathname.substring(1) + u.search;
    isDockerRequest = ['quay.io', 'gcr.io', 'k8s.gcr.io', 'registry.k8s.io', 'ghcr.io', 'docker.cloudsmith.io', 'registry-1.docker.io', 'docker.io'].includes(targetDomain);
    if (targetDomain === 'docker.io') targetDomain = 'registry-1.docker.io';
  } else {
    // 处理 Docker 镜像路径
    if (pathParts[0] === 'docker.io') {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.length === 2 ? `library/${pathParts[1]}` : pathParts.slice(1).join('/');
    } else if (config.ALLOWED_HOSTS.includes(pathParts[0])) {
      targetDomain = pathParts[0];
      targetPath = pathParts.slice(1).join('/') + url.search;
      isDockerRequest = ['quay.io', 'gcr.io', 'k8s.gcr.io', 'registry.k8s.io', 'ghcr.io', 'docker.cloudsmith.io', 'registry-1.docker.io'].includes(targetDomain);
    } else {
      // 默认处理为 Docker Hub 镜像
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      // 智能处理镜像路径：单段为 library/xxx，多段为 user/repo
      targetPath = pathParts.length === 1 ? `library/${pathParts[0]}` : pathParts.join('/');
    }
  }

  // 白名单检查
  if (!config.ALLOWED_HOSTS.includes(targetDomain)) {
    return new Response('Invalid target domain\n', { status: 400 });
  }

  // 路径白名单检查
  if (config.RESTRICT_PATHS && !config.ALLOWED_PATHS.some(p => targetPath.toLowerCase().includes(p.toLowerCase()))) {
    return new Response('Path not allowed\n', { status: 403 });
  }

  // 构建目标 URL - 修复 V2 API 路径问题
  let targetUrl;
  if (isDockerRequest) {
    // 对于 Docker 请求，确保使用 /v2/ API
    if (!targetPath.startsWith('v2/')) {
      targetUrl = `https://${targetDomain}/v2/${targetPath}`;
    } else {
      targetUrl = `https://${targetDomain}/${targetPath}`;
    }
  } else {
    targetUrl = `https://${targetDomain}/${targetPath}`;
  }

  console.log(`Proxying to: ${targetUrl}`);

  const headers = new Headers(request.headers);
  headers.set('Host', targetDomain);
  
  // 清理可能干扰的头部
  headers.delete('x-amz-content-sha256');
  headers.delete('x-amz-date');
  headers.delete('x-amz-security-token');
  headers.delete('x-amz-user-agent');

  let response;
  let redirects = 0;
  const MAX_REDIRECTS = 5;
  let currentUrl = targetUrl;

  try {
    while (redirects <= MAX_REDIRECTS) {
      // 为 S3 请求添加必要的头部
      if (isAmazonS3(currentUrl)) {
        headers.set('x-amz-content-sha256', getEmptyBodySHA256());
        headers.set('x-amz-date', new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5) + 'Z');
      }

      response = await fetch(currentUrl, {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'manual'
      });

      console.log(`Response: ${response.status} from ${currentUrl}`);

      // 处理 Docker 认证
      if (isDockerRequest && response.status === 401) {
        const wwwAuth = response.headers.get('WWW-Authenticate');
        if (wwwAuth) {
          const m = wwwAuth.match(/Bearer realm="([^"]+)",service="([^"]*)",scope="([^"]*)"/);
          if (m) {
            const [, realm, service, scope] = m;
            const token = await handleToken(realm, service || targetDomain, scope, env, currentUrl, tokenMapping);
            if (token) {
              headers.set('Authorization', `Bearer ${token}`);
              // 重试带 token 的请求
              response = await fetch(currentUrl, {
                method: request.method,
                headers: headers,
                body: request.body,
                redirect: 'manual'
              });
              console.log(`Token response: ${response.status}`);
            }
          }
        }
      }

      // 检查重定向
      if ((response.status === 302 || response.status === 307) && response.headers.get('Location')) {
        const redirectUrl = response.headers.get('Location');
        console.log(`Redirect ${redirects + 1}/${MAX_REDIRECTS}: ${redirectUrl}`);
        
        // 防止重定向到自身
        if (redirectUrl.includes(url.hostname)) {
          console.log('Blocked self-redirect');
          break;
        }
        
        currentUrl = redirectUrl;
        redirects++;
        continue;
      }

      // 不是重定向，退出循环
      break;
    }

    // 检查是否超过最大重定向次数
    if (redirects > MAX_REDIRECTS) {
      return new Response(`Too many redirects (${redirects})\n`, { status: 508 });
    }

    // 构建最终响应
    const finalResponse = new Response(response.body, response);
    finalResponse.headers.set('Access-Control-Allow-Origin', '*');
    finalResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    
    if (isDockerRequest) {
      finalResponse.headers.set('Docker-Distribution-API-Version', 'registry/2.0');
    }

    return finalResponse;

  } catch (error) {
    console.log(`Fetch error: ${error.message}`);
    return new Response(`Error fetching from ${targetDomain}: ${error.message}\n`, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
