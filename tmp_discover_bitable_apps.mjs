const appId = process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6';
const appSecret = process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN';

const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret })
});
const tokenData = await tokenResp.json();
const token = tokenData?.tenant_access_token;
if (!token) {
  console.log('no token', JSON.stringify(tokenData));
  process.exit(1);
}

async function call(url) {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  return data;
}

const candidates = [
  'https://open.feishu.cn/open-apis/bitable/v1/apps?page_size=100',
  'https://open.feishu.cn/open-apis/bitable/v1/apps?page_size=100&page_token=',
  'https://open.feishu.cn/open-apis/bitable/v1/apps?user_id_type=open_id',
  'https://open.feishu.cn/open-apis/bitable/v1/apps?view=all&page_size=100'
];
for (const u of candidates) {
  try {
    const d = await call(u);
    console.log('URL', u, 'code', d?.code, 'msg', d?.msg, 'keys', Object.keys(d || {}));
    if (d?.data) console.log('data keys', Object.keys(d.data));
  } catch (e) {
    console.log('URL', u, 'ERROR', e?.message || e);
  }
}
