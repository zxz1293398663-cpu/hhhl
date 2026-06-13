const MISSKEY_HOST = 'https://dc.hhhl.cc'; // 您的 Misskey/Sharkey 实例地址

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type'
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 0. CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 1. 授权端点
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') ?? '';
      const sessionId = crypto.randomUUID();

      // 把 sessionId 自己透传到 callback —— MiAuth 回调时不会带回 session 参数,
      // 后续 token 校验用的就是这个 sessionId。
      const workerCallback = `${url.origin}/callback?r=${encodeURIComponent(redirectUri)}&s=${encodeURIComponent(state)}&sid=${sessionId}`;
      const miAuthUrl = `${MISSKEY_HOST}/miauth/${sessionId}?name=NewAPI%E7%99%BB%E5%BD%95&callback=${encodeURIComponent(workerCallback)}&permission=read:account`;
      return Response.redirect(miAuthUrl, 302);
    }

    // 2. 回调中转
    if (url.pathname === '/callback') {
      const originalRedirectUri = url.searchParams.get('r');
      const state = url.searchParams.get('s') ?? '';
      const sessionId = url.searchParams.get('sid'); // ← 用自己透传的 sid

      if (!originalRedirectUri || !sessionId) {
        return new Response('Invalid callback', { status: 400, headers: CORS_HEADERS });
      }

      // 把 sessionId 当作 OAuth code 回传给 New API
      const targetUrl = `${originalRedirectUri}?code=${encodeURIComponent(sessionId)}&state=${encodeURIComponent(state)}`;
      return Response.redirect(targetUrl, 302);
    }

    // 3. 令牌端点
    if (url.pathname === '/token') {
      let code = url.searchParams.get('code');

      if (!code) {
        try {
          const bodyText = await request.text();
          try {
            const json = JSON.parse(bodyText);
            code = json.code;
          } catch {
            const params = new URLSearchParams(bodyText);
            code = params.get('code');
          }
        } catch (e) {
          console.error('解析 Body 失败:', e);
        }
      }

      if (!code) {
        return jsonResponse({ error: 'invalid_request', error_description: 'Missing code' }, 400);
      }

      // code 即 MiAuth 的 sessionId,用它换 token
      let tokenData;
      try {
        const tokenResponse = await fetch(`${MISSKEY_HOST}/api/miauth/${code}/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...COMMON_HEADERS },
          body: JSON.stringify({})
        });
        tokenData = await tokenResponse.json();
      } catch (e) {
        console.error('MiAuth check 失败:', e);
        return jsonResponse({ error: 'invalid_grant', error_description: 'MiAuth check request failed' }, 400);
      }

      if (!tokenData || !tokenData.ok || !tokenData.token) {
        return jsonResponse({ error: 'invalid_grant', error_description: 'Failed to validate MiAuth session' }, 400);
      }

      return jsonResponse({
        access_token: tokenData.token,
        token_type: 'Bearer'
      });
    }

    // 4. 用户信息端点 (User Info Endpoint)
    if (url.pathname === '/userinfo') {
      let token = url.searchParams.get('access_token');

      if (!token) {
        const authHeader = request.headers.get('Authorization') || '';
        token = authHeader.replace('Bearer ', '').trim();
      }

      if (!token) {
        return jsonResponse({ error: 'invalid_request', error_description: 'Missing token' }, 401);
      }

      let userData;
      try {
        const userResponse = await fetch(`${MISSKEY_HOST}/api/i`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...COMMON_HEADERS },
          body: JSON.stringify({ i: token })
        });
        userData = await userResponse.json();
      } catch (e) {
        console.error('获取用户信息失败:', e);
        return jsonResponse({ error: 'invalid_token', error_description: 'Failed to fetch user info' }, 401);
      }

      if (!userData || !userData.id) {
        return jsonResponse({ error: 'invalid_token' }, 401);
      }

      // 输出 OIDC 标准字段,对齐 New API 面板的字段映射 (sub / preferred_username / name)
      // 不向 New API 提供任何邮箱数据
      const userInfo = {
        sub: userData.id,
        preferred_username: userData.username,
        name: userData.name || userData.username
      };

      return jsonResponse(userInfo);
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }
};
