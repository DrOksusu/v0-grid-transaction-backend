// production 컨테이너 내부에서 upbit-price-manager 호가 캐시 확인 (Map size 명시)
const { getAllStablecoinOrderbooks } = require('/app/dist/services/upbit-price-manager');

const map = getAllStablecoinOrderbooks();
console.log('Map size:', map.size);
console.log('Coins:', Array.from(map.keys()));
console.log('Data:', JSON.stringify(Object.fromEntries(map), null, 2));
