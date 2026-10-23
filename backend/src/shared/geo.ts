/**
 * Vị trí cho matching (TL-01): geohash độ chính xác 4 (ô ~39 × 19,5 km) + 8 ô lân cận,
 * rồi lọc chính xác bằng Haversine. Bán kính tối đa 5 km < cạnh ngắn của ô nên 9 ô luôn phủ đủ.
 */
export const GEOHASH_PRECISION = 4;

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat: number, lng: number, precision = GEOHASH_PRECISION): string {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let hash = '';
  let bits = 0;
  let ch = 0;
  let evenBit = true; // bit chẵn = kinh độ
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) {
        ch = (ch << 1) | 1;
        lngLo = mid;
      } else {
        ch <<= 1;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latLo = mid;
      } else {
        ch <<= 1;
        latHi = mid;
      }
    }
    evenBit = !evenBit;
    if (++bits === 5) {
      hash += BASE32[ch];
      bits = 0;
      ch = 0;
    }
  }
  return hash;
}

function geohashBounds(hash: string) {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let evenBit = true;
  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) throw new Error(`geohash không hợp lệ: ${hash}`);
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lngLo + lngHi) / 2;
        if (bit) lngLo = mid;
        else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (bit) latLo = mid;
        else latHi = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { latLo, latHi, lngLo, lngHi };
}

/** Ô chứa điểm + 8 ô xung quanh (không trùng lặp). */
export function geohashCellsAround(lat: number, lng: number, precision = GEOHASH_PRECISION): string[] {
  const center = geohashEncode(lat, lng, precision);
  const b = geohashBounds(center);
  const dLat = b.latHi - b.latLo;
  const dLng = b.lngHi - b.lngLo;
  const cLat = (b.latLo + b.latHi) / 2;
  const cLng = (b.lngLo + b.lngHi) / 2;
  const cells = new Set<string>();
  for (const i of [-1, 0, 1]) {
    for (const j of [-1, 0, 1]) {
      const la = Math.max(-89.999999, Math.min(89.999999, cLat + i * dLat));
      let lo = cLng + j * dLng;
      if (lo >= 180) lo -= 360;
      if (lo < -180) lo += 360;
      cells.add(geohashEncode(la, lo, precision));
    }
  }
  return [...cells];
}

/** Khoảng cách đường chim bay (km). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Khoảng cách hiển thị cho Partner: làm tròn lên bội 0,5 km, tối thiểu 0,5 (giaiphap E4). */
export const roundDistanceKm = (km: number): number => Math.max(0.5, Math.ceil(km * 2) / 2);
