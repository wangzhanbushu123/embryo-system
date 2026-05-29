/**
 * 微信支付 Native 扫码支付 - Vercel Serverless Function
 * 
 * 环境变量（在 Vercel Dashboard → Settings → Environment Variables 中设置）：
 *   MCH_ID      - 微信支付商户号（10位数字）
 *   API_V3_KEY  - API v3 密钥（32位字符串）
 *   SERIAL_NO   - 商户证书序列号
 *   PRIVATE_KEY - 商户私钥（PEM格式，包含 BEGIN/END 标记）
 */

const crypto = require('crypto');

// ============ 工具函数 ============

function getConfig() {
  // PRIVATE_KEY 从环境变量读取时，换行符可能被转义，需要还原
  let privateKey = process.env.PRIVATE_KEY || '';
  if (privateKey && !privateKey.includes('\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  return {
    mchId: process.env.MCH_ID || '',
    apiV3Key: process.env.API_V3_KEY || '',
    serialNo: process.env.SERIAL_NO || '',
    privateKey: privateKey,
  };
}

function randomStr(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const arr = new Uint8Array(length);
  crypto.randomFillSync(arr);
  for (let i = 0; i < length; i++) {
    result += chars[arr[i] % chars.length];
  }
  return result;
}

function ts() {
  return Math.floor(Date.now() / 1000).toString();
}

function signMessage(message, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  return signer.sign(privateKeyPem, 'base64');
}

function generateAuthHeader(method, url, body, config) {
  const timestamp = ts();
  const nonceStr = randomStr(32);
  const urlObj = new URL(url);
  const canonicalUrl = urlObj.pathname + urlObj.search;

  const bodyStr = body ? JSON.stringify(body) : '';
  const message = method + '\n' + canonicalUrl + '\n' + timestamp + '\n' + nonceStr + '\n' + bodyStr + '\n';

  const signature = signMessage(message, config.privateKey);

  const auth = 'mchid="' + config.mchId + '",nonce_str="' + nonceStr + '",signature="' + signature + '",timestamp="' + timestamp + '",serial_no="' + config.serialNo + '"';

  return {
    'Authorization': 'WECHATPAY2-SHA256-RSA2048 ' + auth,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Vercel Serverless)',
  };
}

// ============ 微信支付 API ============

async function createNativeOrder(description, amount, notifyUrl, config) {
  const outTradeNo = 'PAY' + Date.now() + randomStr(6);
  const url = 'https://api.mch.weixin.qq.com/v3/pay/transactions/native';

  const body = {
    mchid: config.mchId,
    out_trade_no: outTradeNo,
    description: description,
    notify_url: notifyUrl,
    amount: {
      total: parseInt(amount),
      currency: 'CNY',
    },
  };

  const headers = generateAuthHeader('POST', url, body, config);

  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('微信支付API错误: ' + response.status + ' - ' + errorText);
  }

  const data = await response.json();
  return {
    codeUrl: data.code_url,
    outTradeNo: outTradeNo,
  };
}

async function queryOrder(outTradeNo, config) {
  const url = 'https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/' + outTradeNo + '?mchid=' + config.mchId;

  const headers = generateAuthHeader('GET', url, null, config);

  const response = await fetch(url, {
    method: 'GET',
    headers: headers,
  });

  if (response.status === 404) {
    return { status: 'NOTFOUND' };
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('查询订单失败: ' + response.status + ' - ' + errorText);
  }

  const data = await response.json();
  return {
    status: data.trade_state,
    paid: data.trade_state === 'SUCCESS',
    transactionId: data.transaction_id,
    amount: data.amount,
  };
}

// ============ 请求体解析 ============

function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function getBodyRaw(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ============ CORS ============

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function sendJson(res, data, status) {
  status = status || 200;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(data));
}

// ============ 主入口 ============

module.exports = async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
    res.end();
    return;
  }

  const config = getConfig();
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  try {
    // 健康检查
    if (url.pathname === '/api/health') {
      return sendJson(res, {
        status: 'ok',
        mode: 'wechat-native-pay',
        service: 'embryo-diagnosis-system',
        hasConfig: !!(config.mchId && config.serialNo && config.privateKey),
      });
    }

    // 创建 Native 支付订单
    if (url.pathname === '/api/wechat/native' && req.method === 'POST') {
      if (!config.mchId || !config.apiV3Key || !config.serialNo || !config.privateKey) {
        return sendJson(res, {
          code: -1,
          message: '后端支付配置不完整，请在 Vercel 环境变量中设置 MCH_ID, API_V3_KEY, SERIAL_NO, PRIVATE_KEY',
          missing: {
            mchId: !config.mchId,
            apiV3Key: !config.apiV3Key,
            serialNo: !config.serialNo,
            privateKey: !config.privateKey,
          },
        }, 500);
      }

      const body = await getBody(req);
      const result = await createNativeOrder(
        body.description || '诊费支付',
        body.amount,
        body.notifyUrl || (url.origin + '/wechat-notify'),
        config
      );

      return sendJson(res, {
        code: 0,
        message: 'success',
        codeUrl: result.codeUrl,
        outTradeNo: result.outTradeNo,
      });
    }

    // 查询订单状态
    if (url.pathname === '/api/wechat/query' && req.method === 'GET') {
      const outTradeNo = url.searchParams.get('outTradeNo');
      if (!outTradeNo) {
        return sendJson(res, { code: -1, message: '缺少 outTradeNo 参数' }, 400);
      }

      const result = await queryOrder(outTradeNo, config);
      return sendJson(res, {
        code: 0,
        status: result.status,
        paid: result.paid,
        transactionId: result.transactionId,
      });
    }

    // 微信支付回调通知
    if (url.pathname === '/wechat-notify' && req.method === 'POST') {
      const body = await getBodyRaw(req);
      console.log('[WeChat Notify]', body);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('success');
      return;
    }

    // 404
    return sendJson(res, { code: -1, message: '接口不存在: ' + url.pathname }, 404);

  } catch (err) {
    console.error('[Error]', err);
    return sendJson(res, {
      code: -1,
      message: err.message || '服务器内部错误',
    }, 500);
  }
};
