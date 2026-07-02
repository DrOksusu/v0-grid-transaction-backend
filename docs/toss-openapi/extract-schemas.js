// 우리 코드가 사용할 endpoint의 request/response schema를 openapi.json에서 뽑아낸다.
// $ref는 한 단계만 resolve (schemas만).

const path = require('path');
const spec = require('./openapi.json');

const TARGETS = [
  ['POST', '/oauth2/token'],
  ['GET', '/api/v1/prices'],
  ['GET', '/api/v1/stocks'],
  ['GET', '/api/v1/price-limits'],
  ['GET', '/api/v1/accounts'],
  ['GET', '/api/v1/holdings'],
  ['POST', '/api/v1/orders'],
  ['POST', '/api/v1/orders/{orderId}/cancel'],
  ['GET', '/api/v1/market-calendar/KR'],
  ['GET', '/api/v1/buying-power'],
  ['GET', '/api/v1/sellable-quantity'],
  ['GET', '/api/v1/commissions'],
];

function resolveRef(ref) {
  // ex: "#/components/schemas/Foo"
  if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur = spec;
  for (const p of parts) {
    if (!cur) return null;
    cur = cur[p];
  }
  return cur;
}

function expandRefs(obj, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return '[max depth]';
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((x) => expandRefs(x, depth + 1, maxDepth));
  if (obj.$ref) {
    const resolved = resolveRef(obj.$ref);
    if (!resolved) return { unresolvedRef: obj.$ref };
    return expandRefs(resolved, depth + 1, maxDepth);
  }
  const out = {};
  for (const k of Object.keys(obj)) {
    out[k] = expandRefs(obj[k], depth + 1, maxDepth);
  }
  return out;
}

const results = [];
for (const [method, path] of TARGETS) {
  const p = spec.paths[path];
  if (!p) {
    results.push({ method, path, notFound: true });
    continue;
  }
  const op = p[method.toLowerCase()];
  if (!op) {
    results.push({ method, path, notFound: `no ${method}` });
    continue;
  }

  const parameters = (op.parameters || []).map((x) => expandRefs(x));
  const requestBody = op.requestBody ? expandRefs(op.requestBody) : null;
  const responses = {};
  for (const code of Object.keys(op.responses || {})) {
    responses[code] = expandRefs(op.responses[code]);
  }
  results.push({
    method,
    path,
    summary: op.summary,
    description: op.description,
    operationId: op.operationId,
    tags: op.tags,
    parameters,
    requestBody,
    responses,
  });
}

console.log(JSON.stringify(results, null, 2));
